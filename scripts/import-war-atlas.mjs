import { pathToFileURL } from "node:url";

import {
  chunkRecords,
  createCurationCaseRepository,
  normalizeWarAtlasDataset,
} from "../lib/import/war-atlas.mjs";

export const DEFAULT_MANIFEST_URL =
  "https://thewaratlas.co/downloads/manifest.json";
export const DEFAULT_BATTLES_URL =
  "https://thewaratlas.co/downloads/battles.json";

function requiredCredentials(supabaseUrl, serviceRoleKey) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to stage The War Atlas dataset.",
    );
  }
}

async function responseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function checkedFetch(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  const body = await responseBody(response);
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(
      `Request failed (${response.status}) for ${new URL(url).pathname}: ${detail.slice(0, 1000)}`,
    );
  }
  return body;
}

function supabaseHeaders(serviceRoleKey, prefer) {
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

function restUrl(supabaseUrl, table, query = {}) {
  const url = new URL(`/rest/v1/${table}`, `${supabaseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function recordRow(importRunId, record) {
  return {
    import_run_id: importRunId,
    entity_type: record.entityType,
    external_id: record.externalId,
    wikidata_qid: record.wikidataQid,
    checksum: record.checksum,
    payload: record.payload,
  };
}

async function updateRun({
  fetchImpl,
  supabaseUrl,
  serviceRoleKey,
  importRunId,
  patch,
}) {
  await checkedFetch(
    fetchImpl,
    restUrl(supabaseUrl, "import_runs", { id: `eq.${importRunId}` }),
    {
      method: "PATCH",
      headers: supabaseHeaders(serviceRoleKey, "return=minimal"),
      body: JSON.stringify(patch),
    },
  );
}

export async function stageWarAtlas({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
  manifestUrl = DEFAULT_MANIFEST_URL,
  battlesUrl = DEFAULT_BATTLES_URL,
  batchSize = 500,
}) {
  requiredCredentials(supabaseUrl, serviceRoleKey);

  const [manifest, battles] = await Promise.all([
    checkedFetch(fetchImpl, manifestUrl),
    checkedFetch(fetchImpl, battlesUrl),
  ]);
  const normalized = normalizeWarAtlasDataset({ manifest, battles });
  const { run, records } = normalized;
  const curationCases = createCurationCaseRepository({
    request: (payload) => checkedFetch(
      fetchImpl,
      restUrl(supabaseUrl, "rpc/enqueue_curation_case"),
      {
        method: "POST",
        headers: supabaseHeaders(serviceRoleKey),
        body: JSON.stringify(payload),
      },
    ),
  });
  let importRunId;

  try {
    const runResult = await checkedFetch(
      fetchImpl,
      restUrl(supabaseUrl, "import_runs", {
        on_conflict: "source_dataset,source_version",
        select: "id",
      }),
      {
        method: "POST",
        headers: supabaseHeaders(
          serviceRoleKey,
          "resolution=merge-duplicates,return=representation",
        ),
        body: JSON.stringify({
          source_dataset: run.sourceDataset,
          source_version: run.sourceVersion,
          source_url: run.sourceUrl,
          license_name: run.licenseName,
          attribution: run.attribution,
          status: "importing",
          row_counts: run.rowCounts,
          started_at: new Date().toISOString(),
          completed_at: null,
          error_message: null,
        }),
      },
    );

    importRunId = runResult?.[0]?.id;
    if (importRunId === undefined || importRunId === null) {
      throw new Error("Supabase did not return an import run id.");
    }

    for (const batch of chunkRecords(records, batchSize)) {
      await checkedFetch(
        fetchImpl,
        restUrl(supabaseUrl, "import_records", {
          on_conflict: "import_run_id,entity_type,external_id",
        }),
        {
          method: "POST",
          headers: supabaseHeaders(serviceRoleKey, "resolution=merge-duplicates,return=minimal"),
          body: JSON.stringify(batch.map((record) => recordRow(importRunId, record))),
        },
      );

      for (const record of batch) {
        if (record.entityType !== "battle") continue;
        await curationCases.enqueueCase({
          caseKey: `the-war-atlas:battle:${record.externalId}:${run.sourceVersion}`,
          entityType: record.entityType,
          sourceRevision: run.sourceVersion,
          payload: record.payload,
        });
      }
    }

    await updateRun({
      fetchImpl,
      supabaseUrl,
      serviceRoleKey,
      importRunId,
      patch: {
        status: "staged",
        completed_at: new Date().toISOString(),
        error_message: null,
      },
    });

    return {
      importRunId,
      sourceVersion: run.sourceVersion,
      recordsStaged: records.length,
    };
  } catch (error) {
    if (importRunId !== undefined && importRunId !== null) {
      try {
        await updateRun({
          fetchImpl,
          supabaseUrl,
          serviceRoleKey,
          importRunId,
          patch: {
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: String(error?.message ?? error).slice(0, 1000),
          },
        });
      } catch {
        // Preserve the original import failure; database logs retain patch failures.
      }
    }
    throw error;
  }
}

async function main() {
  const result = await stageWarAtlas({
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  console.log(
    `Staged ${result.recordsStaged} records from The War Atlas ${result.sourceVersion} in import run ${result.importRunId}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
