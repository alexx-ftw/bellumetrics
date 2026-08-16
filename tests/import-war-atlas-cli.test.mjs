import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { stageWarAtlas } from "../scripts/import-war-atlas.mjs";

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
  files: { "battles.json": { rows: 2 } },
};

const battles = [
  {
    slug: "battle-one",
    title: "Battle One",
    wikidata_qid: "Q100",
    commanders: [
      { slug: "commander-one", name: "Commander One", side: "A", rank: "General" },
      { slug: "commander-two", name: "Commander Two", side: "B", rank: "General" },
    ],
    source_slugs: ["source-a"],
  },
  {
    slug: "battle-two",
    title: "Battle Two",
    wikidata_qid: "",
    commanders: [
      { slug: "commander-one", name: "Commander One", side: "A", rank: "Marshal" },
      { slug: "commander-three", name: "Commander Three", side: "B", rank: "General" },
    ],
    source_slugs: ["source-b"],
  },
];

async function withImportServer({ failRecordBatch = false } = {}, run) {
  const requests = [];
  let failed = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    const url = new URL(request.url, "http://localhost");
    requests.push({ method: request.method, path: url.pathname, query: url.search, body });

    if (url.pathname === "/manifest.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(manifest));
      return;
    }
    if (url.pathname === "/battles.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(battles));
      return;
    }
    if (url.pathname === "/rest/v1/import_runs" && request.method === "POST") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ id: 42 }]));
      return;
    }
    if (url.pathname === "/rest/v1/import_records" && failRecordBatch && !failed) {
      failed = true;
      response.statusCode = 500;
      response.end("synthetic staging failure");
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run({ baseUrl, requests });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

test("stages an idempotent import in bounded batches", async () => {
  await withImportServer({}, async ({ baseUrl, requests }) => {
    const result = await stageWarAtlas({
      supabaseUrl: baseUrl,
      serviceRoleKey: "test-service-role-key",
      manifestUrl: `${baseUrl}/manifest.json`,
      battlesUrl: `${baseUrl}/battles.json`,
      batchSize: 2,
    });

    assert.deepEqual(result, {
      importRunId: 42,
      sourceVersion: "2026-07-03",
      recordsStaged: 5,
    });

    const recordRequests = requests.filter(({ path }) => path === "/rest/v1/import_records");
    assert.equal(recordRequests.length, 3);
    assert.deepEqual(recordRequests.map(({ body }) => body.length), [2, 2, 1]);
    assert.ok(recordRequests.every(({ query }) =>
      query.includes("on_conflict=import_run_id%2Centity_type%2Cexternal_id")));

    const runRequest = requests.find(
      ({ method, path }) => method === "POST" && path === "/rest/v1/import_runs",
    );
    assert.equal(runRequest.body.source_dataset, "the-war-atlas");
    assert.equal(runRequest.body.license_name, "CC BY 4.0");
    assert.deepEqual(runRequest.body.row_counts, {
      manifest: { battle: 2 },
      actual: { battle: 2, commander: 3 },
    });

    const completion = requests.at(-1);
    assert.equal(completion.method, "PATCH");
    assert.equal(completion.path, "/rest/v1/import_runs");
    assert.equal(completion.body.status, "staged");
    assert.ok(completion.body.completed_at);
  });
});

test("marks a started import as failed without touching canonical tables", async () => {
  await withImportServer({ failRecordBatch: true }, async ({ baseUrl, requests }) => {
    await assert.rejects(
      stageWarAtlas({
        supabaseUrl: baseUrl,
        serviceRoleKey: "test-service-role-key",
        manifestUrl: `${baseUrl}/manifest.json`,
        battlesUrl: `${baseUrl}/battles.json`,
        batchSize: 2,
      }),
      /synthetic staging failure/i,
    );

    assert.equal(requests.at(-1).method, "PATCH");
    assert.equal(requests.at(-1).body.status, "failed");
    assert.match(requests.at(-1).body.error_message, /synthetic staging failure/i);
    assert.equal(
      requests.some(({ path }) =>
        ["/rest/v1/commanders", "/rest/v1/engagements", "/rest/v1/sources"].includes(path)),
      false,
    );
  });
});

test("requires service-role credentials before downloading data", async () => {
  await assert.rejects(
    stageWarAtlas({ supabaseUrl: "", serviceRoleKey: "" }),
    /SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/i,
  );
});
