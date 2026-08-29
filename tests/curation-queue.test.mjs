import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createQueueRepository } from "../lib/curation/queue-repository.mjs";

const foundationMigrationUrl = new URL(
  "../supabase/migrations/202608150001_wiki_data_foundation.sql",
  import.meta.url,
);
const curationMigrationUrl = new URL(
  "../supabase/migrations/20260829182707_ai_curation.sql",
  import.meta.url,
);

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
  await db.exec(await readFile(foundationMigrationUrl, "utf8"));
  await db.exec(await readFile(curationMigrationUrl, "utf8"));
  return db;
}

async function enqueue(db, caseKey, { priority = 0, createdAt } = {}) {
  const { rows } = await db.query(
    `insert into public.curation_cases (
      case_key, entity_type, source_revision, payload, priority, created_at, updated_at
    ) values ($1, 'battle', 'source-v1', '{}'::jsonb, $2, coalesce($3, now()), coalesce($3, now()))
    returning id`,
    [caseKey, priority, createdAt ?? null],
  );
  return rows[0].id;
}

async function lease(db, workerId, leaseSeconds = 300) {
  const { rows } = await db.query(
    "select to_jsonb(public.lease_curation_case($1, $2)) as leased_case",
    [workerId, leaseSeconds],
  );
  return rows[0].leased_case;
}

async function heartbeat(db, caseId, workerId, leaseSeconds = 300) {
  const { rows } = await db.query(
    "select public.heartbeat_curation_case($1, $2, $3) as renewed",
    [caseId, workerId, leaseSeconds],
  );
  return rows[0].renewed;
}

async function release(db, caseId, workerId, outcome, errorText = null) {
  const { rows } = await db.query(
    "select public.release_curation_case($1, $2, $3, $4) as released",
    [caseId, workerId, outcome, errorText],
  );
  return rows[0].released;
}

async function setExpiringLease(db, caseId, workerId, milliseconds = 1_000) {
  await db.query(
    `update public.curation_cases
     set status = 'leased', lease_owner = $2,
         lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond')
     where id = $1`,
    [caseId, workerId, milliseconds],
  );
}

test("leases the oldest case at the highest priority without counting an attempt", async () => {
  const db = await migratedDatabase();
  try {
    await enqueue(db, "low-old", { priority: 1, createdAt: "2026-08-24T01:00:00Z" });
    const expectedId = await enqueue(db, "high-old", {
      priority: 10,
      createdAt: "2026-08-24T02:00:00Z",
    });
    await enqueue(db, "high-new", { priority: 10, createdAt: "2026-08-24T03:00:00Z" });
    await db.exec("set role service_role");

    const beforeLease = Date.now();
    const leasedCase = await lease(db, "worker-a", 120);

    assert.equal(leasedCase.id, expectedId);
    assert.equal(leasedCase.case_key, "high-old");
    assert.equal(leasedCase.status, "leased");
    assert.equal(leasedCase.lease_owner, "worker-a");
    assert.equal(leasedCase.attempt_count, 0);
    assert.ok(Date.parse(leasedCase.lease_expires_at) >= beforeLease + 119_000);
  } finally {
    await db.close();
  }
});

test("does not lease one active case to a second worker", async () => {
  const db = await migratedDatabase();
  try {
    await enqueue(db, "single-case");
    await db.exec("set role service_role");

    const firstLease = await lease(db, "worker-a");
    const secondLease = await lease(db, "worker-b");

    assert.equal(firstLease.case_key, "single-case");
    assert.equal(secondLease, null);
  } finally {
    await db.close();
  }
});

test("heartbeats extend only an active lease owned by the caller", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "heartbeat-case");
    await db.exec("set role service_role");
    const leasedCase = await lease(db, "worker-a", 60);

    assert.equal(await heartbeat(db, caseId, "worker-b", 600), false);
    assert.equal(await heartbeat(db, caseId, "worker-a", 600), true);

    await db.exec("reset role");
    const renewed = (await db.query(
      "select lease_owner, lease_expires_at from public.curation_cases where id = $1",
      [caseId],
    )).rows[0];
    assert.equal(renewed.lease_owner, "worker-a");
    assert.ok(Date.parse(renewed.lease_expires_at) > Date.parse(leasedCase.lease_expires_at));

    await db.query(
      "update public.curation_cases set lease_expires_at = now() - interval '1 second' where id = $1",
      [caseId],
    );
    await db.exec("set role service_role");
    assert.equal(await heartbeat(db, caseId, "worker-a", 600), false);
    await db.exec("reset role");
    const expired = (await db.query(
      "select lease_expires_at from public.curation_cases where id = $1",
      [caseId],
    )).rows[0];
    assert.ok(Date.parse(expired.lease_expires_at) < Date.now());
  } finally {
    await db.close();
  }
});

test("heartbeat checks the wall clock after a delayed lease boundary", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "delayed-heartbeat-case");
    await setExpiringLease(db, caseId, "worker-a");
    await db.exec("set role service_role");

    const { rows } = await db.query(
      `with delayed(case_id) as materialized (
        select $1::bigint from pg_sleep(1.2)
      )
      select public.heartbeat_curation_case(delayed.case_id, $2, 300) as renewed
      from delayed`,
      [caseId, "worker-a"],
    );

    assert.equal(rows[0].renewed, false);
    await db.exec("reset role");
    const state = (await db.query(
      "select status, lease_owner, lease_expires_at from public.curation_cases where id = $1",
      [caseId],
    )).rows[0];
    assert.equal(state.status, "leased");
    assert.equal(state.lease_owner, "worker-a");
    assert.ok(Date.parse(state.lease_expires_at) < Date.now());
  } finally {
    await db.close();
  }
});

test("reclaims an expired lease without counting it as a failed attempt", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "expired-case");
    await db.query(
      `update public.curation_cases
       set status = 'leased', lease_owner = 'dead-worker',
           lease_expires_at = now() - interval '1 minute'
       where id = $1`,
      [caseId],
    );
    await db.exec("set role service_role");

    const leasedCase = await lease(db, "worker-b", 300);

    assert.equal(leasedCase.id, caseId);
    assert.equal(leasedCase.lease_owner, "worker-b");
    assert.equal(leasedCase.attempt_count, 0);
  } finally {
    await db.close();
  }
});

test("records AI reviews only for the active lease owner", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "review-case");
    await db.exec("set role service_role");
    await lease(db, "worker-a", 300);

    const { rows } = await db.query(
      `select public.record_ai_review(
        $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb
      ) as review_id`,
      [
        caseId,
        "worker-a",
        "proposer",
        "test-model",
        "prompt-v1",
        '[{"url":"https://example.test/source"}]',
        '{"action":"approve_battle"}',
      ],
    );
    assert.ok(rows[0].review_id > 0);

    await assert.rejects(
      db.query(
        `select public.record_ai_review(
          $1, $2, 'reviewer', 'test-model', 'prompt-v1', '[]'::jsonb, '{}'::jsonb
        )`,
        [caseId, "worker-b"],
      ),
      /active lease owner/i,
    );

    await db.exec("reset role");
    const reviews = await db.query(
      "select review_role, model, prompt_version, evidence, decision from public.ai_reviews",
    );
    assert.deepEqual(reviews.rows, [{
      review_role: "proposer",
      model: "test-model",
      prompt_version: "prompt-v1",
      evidence: [{ url: "https://example.test/source" }],
      decision: { action: "approve_battle" },
    }]);
  } finally {
    await db.close();
  }
});

test("AI review ownership is checked after a delayed lease boundary", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "delayed-review-case");
    await setExpiringLease(db, caseId, "worker-a");
    await db.exec("set role service_role");

    await assert.rejects(
      db.query(
        `with delayed(case_id) as materialized (
          select $1::bigint from pg_sleep(1.2)
        )
        select public.record_ai_review(
          delayed.case_id, $2, 'proposer', 'test-model', 'prompt-v1',
          '[]'::jsonb, '{}'::jsonb
        )
        from delayed`,
        [caseId, "worker-a"],
      ),
      /active lease owner/i,
    );

    await db.exec("reset role");
    const reviews = await db.query(
      "select count(*)::integer as count from public.ai_reviews where case_id = $1",
      [caseId],
    );
    assert.deepEqual(reviews.rows, [{ count: 0 }]);
  } finally {
    await db.close();
  }
});

test("reads stored reviews only for the current unexpired lease owner", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "resume-review-case");
    await db.exec("set role service_role");
    await lease(db, "worker-a", 300);
    await db.query(
      `select public.record_ai_review(
        $1, $2, 'proposer', 'gpt-test', 'proposer-v1',
        '[{"citation":"source"}]'::jsonb,
        '{"action":"reject_battle"}'::jsonb
      )`,
      [caseId, "worker-a"],
    );

    const { rows } = await db.query(
      "select * from public.read_curation_reviews($1, $2)",
      [caseId, "worker-a"],
    );
    assert.deepEqual(rows, [{
      review_role: "proposer",
      model: "gpt-test",
      prompt_version: "proposer-v1",
      evidence: [{ citation: "source" }],
      decision: { action: "reject_battle" },
    }]);

    await assert.rejects(
      db.query(
        "select * from public.read_curation_reviews($1, $2)",
        [caseId, "worker-b"],
      ),
      /active lease owner/i,
    );
  } finally {
    await db.close();
  }
});

test("releases a successful case once and treats the same completion as idempotent", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "completed-case");
    await db.exec("set role service_role");
    await lease(db, "worker-a");

    assert.equal(await release(db, caseId, "worker-b", "approved"), false);
    assert.equal(await release(db, caseId, "worker-a", "approved"), true);
    assert.equal(await release(db, caseId, "worker-a", "approved"), true);

    await db.exec("reset role");
    const completed = (await db.query(
      `select status, lease_owner, lease_expires_at, attempt_count, last_error
       from public.curation_cases where id = $1`,
      [caseId],
    )).rows[0];
    assert.deepEqual(completed, {
      status: "approved",
      lease_owner: null,
      lease_expires_at: null,
      attempt_count: 0,
      last_error: null,
    });
  } finally {
    await db.close();
  }
});

test("release checks the wall clock after a delayed lease boundary", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "delayed-release-case");
    await setExpiringLease(db, caseId, "worker-a");
    await db.exec("set role service_role");

    const { rows } = await db.query(
      `with delayed(case_id) as materialized (
        select $1::bigint from pg_sleep(1.2)
      )
      select public.release_curation_case(
        delayed.case_id, $2, 'technical_failure', 'late failure'
      ) as released
      from delayed`,
      [caseId, "worker-a"],
    );

    assert.equal(rows[0].released, false);
    await db.exec("reset role");
    const state = (await db.query(
      `select status, lease_owner, attempt_count, last_error
       from public.curation_cases where id = $1`,
      [caseId],
    )).rows[0];
    assert.deepEqual(state, {
      status: "leased",
      lease_owner: "worker-a",
      attempt_count: 0,
      last_error: null,
    });
  } finally {
    await db.close();
  }
});

test("counts technical failures and escalates only the third failure", async () => {
  const db = await migratedDatabase();
  try {
    const caseId = await enqueue(db, "retry-case");
    await db.exec("set role service_role");

    for (let failure = 1; failure <= 3; failure += 1) {
      const leasedCase = await lease(db, `worker-${failure}`);
      assert.equal(leasedCase.id, caseId);
      assert.equal(leasedCase.attempt_count, failure - 1);
      assert.equal(
        await release(
          db,
          caseId,
          `worker-${failure}`,
          "technical_failure",
          `failure ${failure}`,
        ),
        true,
      );

      await db.exec("reset role");
      const state = (await db.query(
        `select status, lease_owner, lease_expires_at, attempt_count, last_error
         from public.curation_cases where id = $1`,
        [caseId],
      )).rows[0];
      assert.deepEqual(state, {
        status: failure === 3 ? "awaiting_human" : "pending",
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: failure,
        last_error: `failure ${failure}`,
      });
      if (failure < 3) await db.exec("set role service_role");
    }
  } finally {
    await db.close();
  }
});

test("grants queue operations only through RPCs", async () => {
  const db = await migratedDatabase();
  try {
    const signatures = [
      "public.lease_curation_case(text,integer)",
      "public.heartbeat_curation_case(bigint,text,integer)",
      "public.release_curation_case(bigint,text,text,text)",
      "public.record_ai_review(bigint,text,text,text,text,jsonb,jsonb)",
      "public.read_curation_reviews(bigint,text)",
    ];
    for (const signature of signatures) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const allowed = (await db.query(
          "select has_function_privilege($1, $2, 'EXECUTE') as allowed",
          [role, signature],
        )).rows[0].allowed;
        assert.equal(
          allowed,
          role === "service_role",
          `${role} has unexpected access to ${signature}`,
        );
      }
    }
  } finally {
    await db.close();
  }
});

test("queue repository maps every operation to its RPC endpoint", async () => {
  const requests = [];
  const replies = [
    { id: 41, case_key: "leased-case", status: "leased" },
    true,
    71,
    [{
      review_role: "proposer",
      model: "gpt-test",
      prompt_version: "prompt-v1",
      evidence: [{ url: "https://example.test/source" }],
      decision: { action: "approve_battle" },
    }],
    true,
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    return new Response(JSON.stringify(replies.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const repository = createQueueRepository({
    supabaseUrl: "https://supabase.test/",
    serviceRoleKey: "service-secret",
    fetchImpl,
  });
  const evidence = [{ url: "https://example.test/source" }];
  const decision = { action: "approve_battle" };

  assert.deepEqual(
    await repository.lease({ workerId: "worker-a", leaseSeconds: 300 }),
    { id: 41, case_key: "leased-case", status: "leased" },
  );
  assert.equal(
    await repository.heartbeat({ caseId: 41, workerId: "worker-a", leaseSeconds: 300 }),
    true,
  );
  assert.equal(await repository.recordReview({
    caseId: 41,
    workerId: "worker-a",
    reviewRole: "proposer",
    model: "gpt-test",
    promptVersion: "prompt-v1",
    evidence,
    decision,
  }), 71);
  assert.deepEqual(
    await repository.readReviews({ caseId: 41, workerId: "worker-a" }),
    [{
      review_role: "proposer",
      model: "gpt-test",
      prompt_version: "prompt-v1",
      evidence,
      decision,
    }],
  );
  assert.equal(await repository.release({
    caseId: 41,
    workerId: "worker-a",
    outcome: "approved",
    errorText: null,
  }), true);

  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    [
      "/rest/v1/rpc/lease_curation_case",
      "/rest/v1/rpc/heartbeat_curation_case",
      "/rest/v1/rpc/record_ai_review",
      "/rest/v1/rpc/read_curation_reviews",
      "/rest/v1/rpc/release_curation_case",
    ],
  );
  assert.deepEqual(
    requests.map(({ options }) => JSON.parse(options.body)),
    [
      { worker_id: "worker-a", lease_seconds: 300 },
      { case_id: 41, worker_id: "worker-a", lease_seconds: 300 },
      {
        case_id: 41,
        worker_id: "worker-a",
        review_role: "proposer",
        model: "gpt-test",
        prompt_version: "prompt-v1",
        evidence,
        decision,
      },
      { case_id: 41, worker_id: "worker-a" },
      {
        case_id: 41,
        worker_id: "worker-a",
        outcome: "approved",
        error_text: null,
      },
    ],
  );
  for (const { options } of requests) {
    assert.equal(options.method, "POST");
    assert.equal(options.headers.apikey, "service-secret");
    assert.equal(options.headers.authorization, "Bearer service-secret");
    assert.equal(options.headers["content-type"], "application/json");
  }
});

test("queue repository accepts PostgREST singleton arrays for composite leases", async () => {
  const repository = createQueueRepository({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-secret",
    fetchImpl: async () => new Response(
      JSON.stringify([{ id: 9, case_key: "singleton-case" }]),
      { status: 200 },
    ),
  });

  assert.deepEqual(
    await repository.lease({ workerId: "worker-a", leaseSeconds: 300 }),
    { id: 9, case_key: "singleton-case" },
  );
});

test("queue repository redacts technical errors before they can be stored", async () => {
  const db = await migratedDatabase();
  const serviceRoleKey = "persisted-service-secret";
  try {
    const caseId = await enqueue(db, "redacted-release-case");
    await db.exec("set role service_role");
    await lease(db, "worker-a");
    let sentPayload;
    const repository = createQueueRepository({
      supabaseUrl: "https://supabase.test",
      serviceRoleKey,
      fetchImpl: async (url, options) => {
        assert.equal(new URL(url).pathname, "/rest/v1/rpc/release_curation_case");
        sentPayload = JSON.parse(options.body);
        const { rows } = await db.query(
          "select public.release_curation_case($1, $2, $3, $4) as released",
          [
            sentPayload.case_id,
            sentPayload.worker_id,
            sentPayload.outcome,
            sentPayload.error_text,
          ],
        );
        return new Response(JSON.stringify(rows[0].released), { status: 200 });
      },
    });

    assert.equal(await repository.release({
      caseId,
      workerId: "worker-a",
      outcome: "technical_failure",
      errorText: `request failed with Authorization: Bearer ${serviceRoleKey}`,
    }), true);
    assert.doesNotMatch(sentPayload.error_text, /persisted-service-secret|Bearer persisted/i);
    assert.match(sentPayload.error_text, /\[REDACTED\]/);

    await db.exec("reset role");
    const storedError = (await db.query(
      "select last_error from public.curation_cases where id = $1",
      [caseId],
    )).rows[0].last_error;
    assert.equal(storedError, sentPayload.error_text);
    assert.doesNotMatch(storedError, /persisted-service-secret|Bearer persisted/i);
  } finally {
    await db.close();
  }
});

test("queue repository redacts service credentials from HTTP and transport errors", async () => {
  const serviceRoleKey = "super-secret-service-key";
  const responseFailure = createQueueRepository({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey,
    fetchImpl: async (_url, options) => new Response(
      JSON.stringify({
        message: `upstream echoed ${options.headers.authorization}`,
        apikey: options.headers.apikey,
      }),
      { status: 500 },
    ),
  });

  await assert.rejects(
    responseFailure.lease({ workerId: "worker-a", leaseSeconds: 300 }),
    (error) => {
      assert.match(error.message, /lease_curation_case.*500/i);
      assert.doesNotMatch(error.message, /super-secret-service-key|Bearer super-secret/i);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );

  const transportFailure = createQueueRepository({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey,
    fetchImpl: async (_url, options) => {
      throw new Error(`socket failed with Authorization: ${options.headers.authorization}`);
    },
  });
  await assert.rejects(
    transportFailure.heartbeat({ caseId: 41, workerId: "worker-a", leaseSeconds: 300 }),
    (error) => {
      assert.match(error.message, /heartbeat_curation_case/i);
      assert.doesNotMatch(error.message, /super-secret-service-key|Bearer super-secret/i);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );

  const bodyReadFailure = createQueueRepository({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey,
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async text() {
        throw new Error(`body read failed with Authorization: Bearer ${serviceRoleKey}`);
      },
    }),
  });
  await assert.rejects(
    bodyReadFailure.release({
      caseId: 41,
      workerId: "worker-a",
      outcome: "technical_failure",
      errorText: "network error",
    }),
    (error) => {
      assert.match(error.message, /release_curation_case/i);
      assert.doesNotMatch(error.message, /super-secret-service-key|Bearer super-secret/i);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
