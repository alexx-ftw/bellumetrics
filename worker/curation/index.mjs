import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { createQueueRepository } from "../../lib/curation/queue-repository.mjs";
import { createPublicationRepository } from "../../lib/curation/publication-repository.mjs";
import { createCodexRunner } from "./codex-runner.mjs";
import { createCurationWorker } from "./orchestrator.mjs";

function requiredEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function attachSignalHandlers({ processLike = process, controller }) {
  const stop = () => controller.abort();
  processLike.once("SIGTERM", stop);
  processLike.once("SIGINT", stop);
  return () => {
    processLike.removeListener("SIGTERM", stop);
    processLike.removeListener("SIGINT", stop);
  };
}

export function createCurationRuntime({
  env = process.env,
  processLike = process,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const supabaseUrl = requiredEnvironment(env, "SUPABASE_URL");
  const serviceRoleKey = requiredEnvironment(env, "SUPABASE_SERVICE_ROLE_KEY");
  const model = requiredEnvironment(env, "CURATION_CODEX_MODEL");
  const credentialDirectory = requiredEnvironment(env, "CURATION_CODEX_HOME");
  const workerId = env.CURATION_WORKER_ID || `${hostname()}-${processLike.pid}`;

  const repository = createQueueRepository({
    supabaseUrl,
    serviceRoleKey,
    fetchImpl,
  });
  const publicationRepository = createPublicationRepository({
    supabaseUrl,
    serviceRoleKey,
    fetchImpl,
  });
  const runner = createCodexRunner({
    cwd: process.cwd(),
    model,
    reasoningEffort: env.CURATION_CODEX_REASONING_EFFORT,
    credentialDirectory,
    sourceEnv: env,
  });
  const worker = createCurationWorker({
    repository,
    runner,
    workerId,
    model,
    publicationRepository,
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
  const { worker } = createCurationRuntime({ env, processLike, fetchImpl, logger });
  const controller = new AbortController();
  const detachSignals = attachSignalHandlers({ processLike, controller });

  try {
    return await worker.run({
      signal: controller.signal,
      once: argv.includes("--once"),
    });
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
