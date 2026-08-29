import { pathToFileURL } from "node:url";

import {
  attachSignalHandlers,
  createCurationRuntime,
} from "./curation/index.mjs";
import { createRankingRuntime } from "./ranking/index.mjs";

function abortableSleep(delay, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function createCombinedWorker({
  curationWorker,
  rankingWorker,
  idlePollMs = 5_000,
  initialRetryMs = 1_000,
  maximumRetryMs = 15 * 60_000,
  sleep = abortableSleep,
  logger = { error() {} },
}) {
  if (!curationWorker || typeof curationWorker.runOnce !== "function") {
    throw new TypeError("curationWorker with runOnce() is required");
  }
  if (!rankingWorker || typeof rankingWorker.runOnce !== "function") {
    throw new TypeError("rankingWorker with runOnce() is required");
  }

  async function runOnce() {
    let curation;
    let curationError;
    try {
      curation = await curationWorker.runOnce();
    } catch (error) {
      curationError = error;
    }

    let ranking;
    let rankingError;
    try {
      ranking = await rankingWorker.runOnce();
    } catch (error) {
      rankingError = error;
    }

    if (curationError && rankingError) {
      throw new AggregateError(
        [curationError, rankingError],
        "curation and ranking iterations failed",
      );
    }
    if (curationError) throw curationError;
    if (rankingError) throw rankingError;
    return { curation, ranking };
  }

  async function run({ signal = new AbortController().signal, once = false } = {}) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const result = await runOnce();
        consecutiveFailures = 0;
        if (once) return result;
        if (result.curation.kind === "idle" && result.ranking.kind === "idle") {
          await sleep(idlePollMs, signal);
        }
      } catch (error) {
        if (once) throw error;
        consecutiveFailures += 1;
        logger.error(error instanceof Error ? error.message : String(error));
        await sleep(
          Math.min(initialRetryMs * (2 ** (consecutiveFailures - 1)), maximumRetryMs),
          signal,
        );
      }
    }
    return { kind: "stopped" };
  }

  return { runOnce, run };
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  processLike = process,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const { worker: curationWorker } = createCurationRuntime({
    env,
    processLike,
    fetchImpl,
    logger,
  });
  const { worker: rankingWorker } = createRankingRuntime({
    env,
    processLike,
    fetchImpl,
    logger,
  });
  const worker = createCombinedWorker({ curationWorker, rankingWorker, logger });
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
