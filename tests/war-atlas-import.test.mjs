import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  chunkRecords,
  normalizeWarAtlasDataset,
} from "../lib/import/war-atlas.mjs";
import { stageWarAtlas } from "../scripts/import-war-atlas.mjs";

const foundationMigrationUrl = new URL(
  "../supabase/migrations/202608150001_wiki_data_foundation.sql",
  import.meta.url,
);

const curationMigrationUrl = new URL(
  "../supabase/migrations/20260829182707_ai_curation.sql",
  import.meta.url,
);

const manifest = {
  name: "The War Atlas — Open Dataset",
  version: "2026-07-03",
  generated_at: "2026-07-03T02:24:58.862887+00:00",
  dataset_page: "https://thewaratlas.co/data",
  license: {
    name: "CC BY 4.0",
    attribution: "The War Atlas — thewaratlas.co",
    attribution_url: "https://thewaratlas.co",
  },
  files: {
    "battles.json": { rows: 2 },
  },
};

const battles = [
  {
    slug: "battle-one",
    title: "Battle One",
    war_slug: "example-war",
    campaign_slug: "example-campaign",
    year: 1800,
    date_iso: "1800-01-01",
    result: "",
    wikidata_qid: "Q100",
    forces: [
      { side: "France", strength_low: 1000, strength_high: 1200, confidence: "medium" },
      { side: "Coalition", strength_low: 900, strength_high: 1100, confidence: "low" },
    ],
    casualties: [],
    commanders: [
      { slug: "napoleon", name: "Napoléon Bonaparte", side: "France", rank: "General" },
      { slug: "opponent-one", name: "Opponent One", side: "Coalition", rank: "General" },
    ],
    source_slugs: ["source-a"],
  },
  {
    slug: "battle-two",
    title: "Battle Two",
    war_slug: "example-war",
    campaign_slug: "",
    year: 1801,
    date_iso: "1801-02-03",
    result: "",
    wikidata_qid: null,
    forces: [],
    casualties: [],
    commanders: [
      { slug: "napoleon", name: "Napoléon Bonaparte", side: "France", rank: "First Consul" },
      { slug: "opponent-two", name: "Opponent Two", side: "Coalition", rank: "Field Marshal" },
    ],
    source_slugs: ["source-b", "source-c"],
  },
];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function warAtlasImportFetch({ failEnqueue = false } = {}) {
  const curationCases = new Map();
  const requests = [];
  let sourceRevision = manifest.version;

  const fetchImpl = async (url, options = {}) => {
    const requestUrl = new URL(url);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method, path: requestUrl.pathname, body });

    if (requestUrl.pathname === "/manifest.json") {
      return jsonResponse({ ...manifest, version: sourceRevision });
    }
    if (requestUrl.pathname === "/battles.json") return jsonResponse(battles);
    if (requestUrl.pathname === "/rest/v1/import_runs" && method === "POST") {
      return jsonResponse([{ id: 42 }]);
    }
    if (requestUrl.pathname === "/rest/v1/rpc/enqueue_curation_case") {
      if (failEnqueue) return new Response("synthetic enqueue failure", { status: 500 });
      const existing = curationCases.get(body.p_case_key);
      const terminal = new Set(["approved", "rejected", "published", "failed"]);
      curationCases.set(body.p_case_key, {
        caseKey: body.p_case_key,
        entityType: body.p_entity_type,
        sourceRevision: body.p_source_revision,
        payload: existing && terminal.has(existing.status) ? existing.payload : body.p_payload,
        status: existing?.status ?? "pending",
      });
      return jsonResponse(null);
    }
    if (requestUrl.pathname.startsWith("/rest/v1/")) return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  };

  return {
    curationCases,
    requests,
    setSourceRevision(value) {
      sourceRevision = value;
    },
    async stage() {
      return stageWarAtlas({
        supabaseUrl: "https://supabase.test",
        serviceRoleKey: "test-service-role-key",
        fetchImpl,
        manifestUrl: "https://source.test/manifest.json",
        battlesUrl: "https://source.test/battles.json",
        batchSize: 2,
      });
    },
  };
}

async function migratedCurationDatabase() {
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

test("normalizes battles and deduplicates embedded commanders", () => {
  const result = normalizeWarAtlasDataset({ manifest, battles });

  assert.equal(result.run.sourceDataset, "the-war-atlas");
  assert.equal(result.run.sourceVersion, "2026-07-03");
  assert.equal(result.run.licenseName, "CC BY 4.0");
  assert.equal(result.run.attribution, "The War Atlas — thewaratlas.co");
  assert.deepEqual(result.run.rowCounts, {
    manifest: { battle: 2 },
    actual: { battle: 2, commander: 3 },
  });
  assert.equal(result.records.filter((row) => row.entityType === "battle").length, 2);
  assert.equal(result.records.filter((row) => row.entityType === "commander").length, 3);
  assert.ok(result.records.every((row) => row.checksum.length === 64));

  const napoleon = result.records.find(
    (row) => row.entityType === "commander" && row.externalId === "napoleon",
  );
  assert.deepEqual(napoleon.payload, {
    appearances: [
      { battleSlug: "battle-one", rank: "General", side: "France" },
      { battleSlug: "battle-two", rank: "First Consul", side: "France" },
    ],
    name: "Napoléon Bonaparte",
    slug: "napoleon",
  });

  const battle = result.records.find(
    (row) => row.entityType === "battle" && row.externalId === "battle-one",
  );
  assert.equal(battle.wikidataQid, "Q100");
  assert.deepEqual(battle.payload.source_slugs, ["source-a"]);
});

test("chunks staging records into bounded batches", () => {
  assert.deepEqual(chunkRecords([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.throws(() => chunkRecords([1], 0), /positive integer/i);
});

test("rejects a dataset without the required reusable license", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest: { ...manifest, license: { ...manifest.license, name: "All rights reserved" } },
      battles,
    }),
    /CC BY 4\.0/i,
  );
});

test("rejects noncanonical attribution text", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest: {
        ...manifest,
        license: { ...manifest.license, attribution: "The War Atlas" },
      },
      battles,
    }),
    /attribution must be The War Atlas — thewaratlas\.co/i,
  );
});

test("rejects a manifest battle count that differs from the fetched dataset", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest: {
        ...manifest,
        files: { "battles.json": { rows: 1 } },
      },
      battles,
    }),
    /manifest battle count 1 does not match 2 fetched battles/i,
  );
});

test("rejects conflicting duplicate battle slugs", () => {
  assert.throws(
    () => normalizeWarAtlasDataset({
      manifest,
      battles: [...battles, { ...battles[0], title: "Conflicting title" }],
    }),
    /duplicate battle slug.*battle-one/i,
  );
});

test("rejects embedded commanders without stable slugs", () => {
  const invalidBattle = {
    ...battles[0],
    commanders: [{ slug: "", name: "Unnamed", side: "France", rank: "" }],
  };

  assert.throws(
    () => normalizeWarAtlasDataset({ manifest, battles: [invalidBattle] }),
    /commander slug.*battle-one/i,
  );
});

test("rejects conflicting names for the same commander slug", () => {
  const conflictingBattle = {
    ...battles[1],
    commanders: [
      { slug: "napoleon", name: "Different Person", side: "France", rank: "General" },
    ],
  };

  assert.throws(
    () => normalizeWarAtlasDataset({ manifest, battles: [battles[0], conflictingBattle] }),
    /conflicting commander.*napoleon/i,
  );
});

test("enqueues one idempotent battle curation case for each imported source revision", async () => {
  const importer = warAtlasImportFetch();
  const firstRevision = "2026-07-03";
  const changedRevision = "2026-07-04";

  await importer.stage();
  await importer.stage();
  assert.deepEqual([...importer.curationCases.keys()].sort(), [
    "the-war-atlas:battle:battle-one:2026-07-03",
    "the-war-atlas:battle:battle-two:2026-07-03",
  ]);

  importer.setSourceRevision(changedRevision);
  await importer.stage();
  assert.deepEqual([...importer.curationCases.keys()].sort(), [
    "the-war-atlas:battle:battle-one:2026-07-03",
    "the-war-atlas:battle:battle-one:2026-07-04",
    "the-war-atlas:battle:battle-two:2026-07-03",
    "the-war-atlas:battle:battle-two:2026-07-04",
  ]);
  assert.equal(
    importer.requests.filter(({ path }) => path === "/rest/v1/rpc/enqueue_curation_case").length,
    6,
  );
});

test("marks an import run failed when enqueueing a staged battle case fails", async () => {
  const importer = warAtlasImportFetch({ failEnqueue: true });

  await assert.rejects(importer.stage(), /synthetic enqueue failure/i);

  const runUpdates = importer.requests.filter(
    ({ method, path }) => method === "PATCH" && path === "/rest/v1/import_runs",
  );
  assert.equal(runUpdates.at(-1).body.status, "failed");
  assert.match(runUpdates.at(-1).body.error_message, /synthetic enqueue failure/i);
});

test("enqueue RPC refreshes pending cases but preserves terminal curation decisions", async () => {
  const db = await migratedCurationDatabase();
  const sourceRevision = "2026-07-03";
  try {
    await db.exec("set role service_role");
    await assert.rejects(
      db.query(
        "insert into public.curation_cases (case_key, entity_type, source_revision, payload) values ($1, $2, $3, $4::jsonb)",
        ["direct-write-case", "battle", sourceRevision, '{"title":"direct write"}'],
      ),
      /permission denied/i,
    );

    for (const status of ["pending", "leased", "awaiting_human"]) {
      const caseKey = `mutable-${status}`;
      await db.query(
        "select * from public.enqueue_curation_case($1, $2, $3, $4::jsonb)",
        [caseKey, "battle", sourceRevision, '{"title":"first import"}'],
      );
      await db.exec("reset role");
      await db.query(
        "update public.curation_cases set status = $1 where case_key = $2",
        [status, caseKey],
      );
      await db.exec("set role service_role");
      await db.query(
        "select * from public.enqueue_curation_case($1, $2, $3, $4::jsonb)",
        [caseKey, "battle", sourceRevision, '{"title":"refreshed import"}'],
      );
      await db.exec("reset role");
      const result = await db.query(
        "select payload, status from public.curation_cases where case_key = $1",
        [caseKey],
      );
      assert.deepEqual(result.rows, [{ payload: { title: "refreshed import" }, status }]);
      await db.exec("set role service_role");
    }

    for (const status of ["approved", "rejected", "published", "failed"]) {
      const caseKey = `terminal-${status}`;
      await db.query(
        "select * from public.enqueue_curation_case($1, $2, $3, $4::jsonb)",
        [caseKey, "battle", sourceRevision, '{"title":"first import"}'],
      );
      await db.exec("reset role");
      await db.query(
        "update public.curation_cases set status = $1 where case_key = $2",
        [status, caseKey],
      );
      await db.exec("set role service_role");
      await db.query(
        "select * from public.enqueue_curation_case($1, $2, $3, $4::jsonb)",
        [caseKey, "battle", sourceRevision, '{"title":"retry after terminal state"}'],
      );
      await db.exec("reset role");
      const result = await db.query(
        "select payload, status from public.curation_cases where case_key = $1",
        [caseKey],
      );
      assert.deepEqual(result.rows, [{ payload: { title: "first import" }, status }]);
      await db.exec("set role service_role");
    }
  } finally {
    await db.close();
  }
});
