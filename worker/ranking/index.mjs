import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { createRankingRepository } from "../../lib/ranking/repository.mjs";
import { attachSignalHandlers } from "../curation/index.mjs";
import { createRankingWorker } from "./orchestrator.mjs";

function requiredEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function createRankingRuntime({
  env = process.env,
  processLike = process,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const supabaseUrl = requiredEnvironment(env, "SUPABASE_URL");
  const serviceRoleKey = requiredEnvironment(env, "SUPABASE_SERVICE_ROLE_KEY");
  const workerId = env.RANKING_WORKER_ID || `${hostname()}-${processLike.pid}-ranking`;
  const repository = createRankingRepository({ supabaseUrl, serviceRoleKey, fetchImpl });
  const worker = createRankingWorker({
    repository,
    workerId,
    logger,
    secrets: [serviceRoleKey],
  });
  return { worker, workerId };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  processLike = process,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const { worker } = createRankingRuntime({ env, processLike, fetchImpl, logger });
  const controller = new AbortController();
  const detachSignals = attachSignalHandlers({ processLike, controller });
  try {
    return await worker.run({ signal: controller.signal, once: argv.includes("--once") });
  } finally {
    detachSignals();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
