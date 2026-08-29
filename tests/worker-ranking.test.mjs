import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createRankingRepository } from "../lib/ranking/repository.mjs";
import { createCombinedWorker } from "../worker/index.mjs";
import { createRankingWorker } from "../worker/ranking/orchestrator.mjs";

const migrationUrls = [
  new URL("../supabase/migrations/202608150001_wiki_data_foundation.sql", import.meta.url),
  new URL("../supabase/migrations/20260829182707_ai_curation.sql", import.meta.url),
  new URL("../supabase/migrations/20260829182958_publication_and_ranking.sql", import.meta.url),
];

const workerInput = {
  commanders: [
    { id: 1, publication_status: "published" },
    { id: 2, publication_status: "published" },
  ],
  engagements: [{
    id: 10,
    start_year: 1815,
    elo_eligible: true,
    publication_status: "published",
  }],
  participations: [
    {
      id: 101,
      engagement_id: 10,
      engagement_side_id: 1001,
      commander_id: 1,
      outcome: "victory",
    },
    {
      id: 102,
      engagement_id: 10,
      engagement_side_id: 1002,
      commander_id: 2,
      outcome: "defeat",
    },
  ],
};

async function migratedDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid
      language sql stable
      as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
    grant usage on schema auth to authenticated;
  `);
  for (const migrationUrl of migrationUrls) {
    await db.exec(await readFile(migrationUrl, "utf8"));
  }
  return db;
}

async function insertJob(db, revision, createdAt = "2026-08-24T00:00:00Z") {
  const { rows } = await db.query(
    `insert into public.ranking_jobs (
      data_revision, algorithm_version, created_at
    ) values ($1, 'elo-v1', $2) returning id`,
    [revision, createdAt],
  );
  return rows[0].id;
}

async function leaseJob(db, workerId, leaseSeconds = 300) {
  const { rows } = await db.query(
    "select to_jsonb(public.lease_ranking_job($1, $2)) as job",
    [workerId, leaseSeconds],
  );
  return rows[0].job;
}

test("ranking RPCs can only be executed by service_role", async () => {
  const db = await migratedDatabase();
  try {
    const signatures = [
      "public.lease_ranking_job(text,integer)",
      "public.heartbeat_ranking_job(bigint,text,integer)",
      "public.read_ranking_input(bigint,text)",
      "public.complete_ranking_job(bigint,text,text,jsonb)",
      "public.release_ranking_job(bigint,text,text)",
    ];
    for (const signature of signatures) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const { rows } = await db.query(
          "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
          [role, signature],
        );
        assert.equal(rows[0].allowed, role === "service_role", `${role}: ${signature}`);
      }
    }
  } finally {
    await db.close();
  }
});

test("ranking leases claim the oldest pending job once and reclaim expired work", async () => {
  const db = await migratedDatabase();
  try {
    const oldestId = await insertJob(db, "ranking-old", "2026-08-24T01:00:00Z");
    await insertJob(db, "ranking-new", "2026-08-24T02:00:00Z");
    await db.exec("set role service_role");

    const first = await leaseJob(db, "ranking-a", 60);
    const second = await leaseJob(db, "ranking-b", 60);
    assert.equal(first.id, oldestId);
    assert.equal(first.lease_owner, "ranking-a");
    assert.equal(second.data_revision, "ranking-new");

    await db.exec("reset role");
    await db.query(
      `update public.ranking_jobs
       set lease_expires_at = clock_timestamp() - interval '1 second'
       where id = $1`,
      [oldestId],
    );
    await db.exec("set role service_role");
    const reclaimed = await leaseJob(db, "ranking-c", 60);
    assert.equal(reclaimed.id, oldestId);
    assert.equal(reclaimed.lease_owner, "ranking-c");
  } finally {
    await db.close();
  }
});

test("ranking heartbeat extends only the caller's active lease", async () => {
  const db = await migratedDatabase();
  try {
    const jobId = await insertJob(db, "ranking-heartbeat");
    await db.exec("set role service_role");
    const leased = await leaseJob(db, "ranking-a", 60);
    const wrongOwner = await db.query(
      "select public.heartbeat_ranking_job($1, 'ranking-b', 600) as renewed",
      [jobId],
    );
    const owner = await db.query(
      "select public.heartbeat_ranking_job($1, 'ranking-a', 600) as renewed",
      [jobId],
    );

    assert.equal(wrongOwner.rows[0].renewed, false);
    assert.equal(owner.rows[0].renewed, true);
    await db.exec("reset role");
    const { rows } = await db.query(
      "select lease_expires_at from public.ranking_jobs where id = $1",
      [jobId],
    );
    assert.ok(Date.parse(rows[0].lease_expires_at) > Date.parse(leased.lease_expires_at));
  } finally {
    await db.close();
  }
});

test("ranking input exposes only published commanders and eligible published engagements", async () => {
  const db = await migratedDatabase();
  try {
    const jobId = await insertJob(db, "ranking-input");
    await db.exec(`
      insert into public.commanders (slug, display_name, publication_status) values
        ('ranking-a', 'Ranking A', 'published'),
        ('ranking-b', 'Ranking B', 'published'),
        ('ranking-hidden', 'Ranking Hidden', 'pending');
      insert into public.engagements (
        slug, title, start_year, elo_eligible, publication_status
      ) values
        ('ranking-counted', 'Ranking Counted', 1815, true, 'published'),
        ('ranking-pending', 'Ranking Pending', 1816, true, 'pending'),
        ('ranking-ineligible', 'Ranking Ineligible', 1817, false, 'published');
      insert into public.engagement_sides (engagement_id, position, label, outcome)
      select e.id, side.position, side.label, side.outcome
      from public.engagements e
      cross join (values
        (1, 'A', 'victory'),
        (2, 'B', 'defeat')
      ) as side(position, label, outcome);
      insert into public.participations (engagement_side_id, commander_id, role)
      select s.id, c.id, 'commander'
      from public.engagement_sides s
      join public.engagements e on e.id = s.engagement_id
      join public.commanders c on c.slug = case when s.position = 1 then 'ranking-a' else 'ranking-b' end;
    `);
    await db.exec("set role service_role");
    await leaseJob(db, "ranking-a");
    const { rows } = await db.query(
      "select public.read_ranking_input($1, 'ranking-a') as input",
      [jobId],
    );

    assert.deepEqual(rows[0].input.commanders.map(({ publication_status }) => publication_status), [
      "published",
      "published",
    ]);
    assert.deepEqual(rows[0].input.engagements.map(({ id }) => id), [
      rows[0].input.participations[0].engagement_id,
    ]);
    assert.equal(rows[0].input.participations.length, 2);
  } finally {
    await db.close();
  }
});

test("completion inserts one idempotent snapshot and completes the job atomically", async () => {
  const db = await migratedDatabase();
  try {
    const jobId = await insertJob(db, "ranking-complete");
    const results = {
      ratings: [],
      battleDeltas: [],
      inputDigest: `sha256:${"a".repeat(64)}`,
    };
    await db.exec("set role service_role");
    await leaseJob(db, "ranking-a");
    const first = await db.query(
      "select public.complete_ranking_job($1, 'ranking-a', $2, $3::jsonb) as snapshot_id",
      [jobId, results.inputDigest, JSON.stringify(results)],
    );
    const repeated = await db.query(
      "select public.complete_ranking_job($1, 'ranking-a', $2, $3::jsonb) as snapshot_id",
      [jobId, results.inputDigest, JSON.stringify(results)],
    );

    assert.equal(repeated.rows[0].snapshot_id, first.rows[0].snapshot_id);
    await db.exec("reset role");
    const { rows } = await db.query(
      `select j.status, j.completed_at is not null as completed,
        count(s.id)::integer as snapshots
       from public.ranking_jobs j
       left join public.ranking_snapshots s
         on s.data_revision = j.data_revision
        and s.algorithm_version = j.algorithm_version
       where j.id = $1
       group by j.id`,
      [jobId],
    );
    assert.deepEqual(rows[0], { status: "completed", completed: true, snapshots: 1 });
  } finally {
    await db.close();
  }
});

test("failed completion leaves the previous snapshot untouched and rolls back the new one", async () => {
  const db = await migratedDatabase();
  try {
    await db.exec(`
      insert into public.ranking_snapshots (data_revision, algorithm_version, results)
      values ('previous-revision', 'elo-v1', '{"marker":"previous"}'::jsonb);
      create function public.reject_ranking_completion() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'completed' then raise exception 'forced completion failure'; end if;
        return new;
      end
      $$;
      create trigger reject_ranking_completion before update on public.ranking_jobs
      for each row execute function public.reject_ranking_completion();
    `);
    const jobId = await insertJob(db, "failed-revision");
    const digest = `sha256:${"b".repeat(64)}`;
    await db.exec("set role service_role");
    await leaseJob(db, "ranking-a");
    await assert.rejects(
      db.query(
        "select public.complete_ranking_job($1, 'ranking-a', $2, $3::jsonb)",
        [jobId, digest, JSON.stringify({ inputDigest: digest, ratings: [], battleDeltas: [] })],
      ),
      /forced completion failure/,
    );
    await db.exec("reset role");

    const { rows } = await db.query(`
      select data_revision, results->>'marker' as marker
      from public.ranking_snapshots order by id
    `);
    assert.deepEqual(rows, [{ data_revision: "previous-revision", marker: "previous" }]);
    const job = (await db.query(
      "select status, completed_at from public.ranking_jobs where id = $1",
      [jobId],
    )).rows[0];
    assert.deepEqual(job, { status: "leased", completed_at: null });
  } finally {
    await db.close();
  }
});

test("technical ranking failures retry twice and become failed on the third release", async () => {
  const db = await migratedDatabase();
  try {
    const jobId = await insertJob(db, "ranking-retry");
    await db.exec("set role service_role");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await leaseJob(db, `ranking-${attempt}`);
      const { rows } = await db.query(
        "select public.release_ranking_job($1, $2, 'calculation failed') as released",
        [jobId, `ranking-${attempt}`],
      );
      assert.equal(rows[0].released, true);
    }
    await db.exec("reset role");
    const { rows } = await db.query(
      "select status, attempt_count, last_error from public.ranking_jobs where id = $1",
      [jobId],
    );
    assert.deepEqual(rows[0], {
      status: "failed",
      attempt_count: 3,
      last_error: "calculation failed",
    });
  } finally {
    await db.close();
  }
});

test("ranking repository maps the service-role RPC lifecycle", async () => {
  const calls = [];
  const responses = [
    [{ id: 11, data_revision: "source-v1", algorithm_version: "elo-v1" }],
    true,
    workerInput,
    19,
    true,
  ];
  const repository = createRankingRepository({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-secret",
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal((await repository.lease({ workerId: "ranking-a", leaseSeconds: 300 })).id, 11);
  assert.equal(await repository.heartbeat({ jobId: 11, workerId: "ranking-a", leaseSeconds: 300 }), true);
  assert.deepEqual(await repository.readInput({ jobId: 11, workerId: "ranking-a" }), workerInput);
  assert.equal(await repository.complete({
    jobId: 11,
    workerId: "ranking-a",
    inputDigest: `sha256:${"c".repeat(64)}`,
    results: { ratings: [], battleDeltas: [], inputDigest: `sha256:${"c".repeat(64)}` },
  }), 19);
  assert.equal(await repository.release({
    jobId: 11,
    workerId: "ranking-a",
    errorText: "retry",
  }), true);

  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/rest/v1/rpc/lease_ranking_job",
    "/rest/v1/rpc/heartbeat_ranking_job",
    "/rest/v1/rpc/read_ranking_input",
    "/rest/v1/rpc/complete_ranking_job",
    "/rest/v1/rpc/release_ranking_job",
  ]);
  assert.equal(calls.every(({ init }) => init.headers.apikey === "service-secret"), true);
  assert.equal(calls.every(({ init }) => init.headers.authorization === "Bearer service-secret"), true);
});

test("ranking repository redacts service credentials from failures", async () => {
  const repository = createRankingRepository({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-secret",
    async fetchImpl() {
      throw new Error("Authorization: Bearer service-secret");
    },
  });

  await assert.rejects(
    repository.lease({ workerId: "ranking-a", leaseSeconds: 300 }),
    (error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /service-secret/);
      return true;
    },
  );
});

test("ranking worker leases, reads, calculates, renews, and completes in order", async () => {
  const events = [];
  const repository = {
    async lease() {
      events.push("lease");
      return { id: 11, data_revision: "source-v1", algorithm_version: "elo-v1" };
    },
    async readInput() {
      events.push("read");
      return workerInput;
    },
    async heartbeat() {
      events.push("heartbeat");
      return true;
    },
    async complete(value) {
      events.push("complete");
      assert.match(value.inputDigest, /^sha256:/);
      assert.equal(value.results.ratings[0].rating, 1516);
      return 19;
    },
    async release() {
      events.push("unexpected-release");
      return true;
    },
  };
  const worker = createRankingWorker({ repository, workerId: "ranking-a" });

  const result = await worker.runOnce();

  assert.deepEqual(events, ["lease", "read", "heartbeat", "complete"]);
  assert.deepEqual(result, {
    kind: "completed",
    jobId: 11,
    snapshotId: 19,
    inputDigest: result.inputDigest,
  });
  assert.match(result.inputDigest, /^sha256:[a-f0-9]{64}$/);
});

test("ranking worker releases technical failures with redacted errors", async () => {
  const releases = [];
  const logs = [];
  const worker = createRankingWorker({
    repository: {
      lease: async () => ({ id: 11, data_revision: "source-v1", algorithm_version: "elo-v1" }),
      readInput: async () => workerInput,
      heartbeat: async () => true,
      complete: async () => {
        throw new Error("Authorization: Bearer service-secret");
      },
      async release(value) {
        releases.push(value);
        return true;
      },
    },
    workerId: "ranking-a",
    secrets: ["service-secret"],
    logger: { error: (message) => logs.push(message) },
  });

  await assert.rejects(worker.runOnce(), /\[REDACTED\]/);
  assert.equal(releases.length, 1);
  assert.doesNotMatch(releases[0].errorText, /service-secret/);
  assert.doesNotMatch(logs.join("\n"), /service-secret/);
});

test("combined worker runs ranking immediately after every curation iteration", async () => {
  const events = [];
  const worker = createCombinedWorker({
    curationWorker: {
      async runOnce() {
        events.push("curation");
        return { kind: "execute" };
      },
    },
    rankingWorker: {
      async runOnce() {
        events.push("ranking");
        return { kind: "completed" };
      },
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    curation: { kind: "execute" },
    ranking: { kind: "completed" },
  });
  assert.deepEqual(events, ["curation", "ranking"]);
});

test("combined worker still polls ranking after a curation failure", async () => {
  const events = [];
  const worker = createCombinedWorker({
    curationWorker: {
      async runOnce() {
        events.push("curation");
        throw new Error("curation failed");
      },
    },
    rankingWorker: {
      async runOnce() {
        events.push("ranking");
        return { kind: "idle" };
      },
    },
  });

  await assert.rejects(worker.runOnce(), /curation failed/);
  assert.deepEqual(events, ["curation", "ranking"]);
});
