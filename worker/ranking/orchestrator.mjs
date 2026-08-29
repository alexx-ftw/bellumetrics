import { calculateSnapshot } from "../../lib/ranking/elo.mjs";

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

function redact(value, secrets) {
  let redacted = String(value)
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  return redacted;
}

function sanitizedError(error, secrets) {
  return new Error(redact(error instanceof Error ? error.message : error, secrets));
}

export function createRankingWorker({
  repository,
  workerId,
  leaseSeconds = 300,
  heartbeatIntervalMs = 60_000,
  idlePollMs = 5_000,
  initialRetryMs = 1_000,
  maximumRetryMs = 15 * 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  sleep = abortableSleep,
  calculateSnapshotFn = calculateSnapshot,
  logger = { error() {} },
  secrets = [],
}) {
  if (!repository || typeof repository.lease !== "function") {
    throw new TypeError("repository with lease() is required");
  }
  if (typeof workerId !== "string" || workerId.trim() === "") {
    throw new TypeError("workerId is required");
  }

  async function runOnce() {
    const job = await repository.lease({ workerId, leaseSeconds });
    if (!job) return { kind: "idle" };

    let heartbeatFailure = null;
    let heartbeatTail = Promise.resolve();
    let timerCleared = false;
    const renewLease = () => {
      const renewal = heartbeatTail.then(async () => {
        if (heartbeatFailure) throw heartbeatFailure;
        try {
          const renewed = await repository.heartbeat({
            jobId: job.id,
            workerId,
            leaseSeconds,
          });
          if (renewed !== true) throw new Error("ranking lease heartbeat was rejected");
        } catch (error) {
          heartbeatFailure = error;
          throw error;
        }
      });
      heartbeatTail = renewal.catch(() => {});
      return renewal;
    };
    const timer = setIntervalFn(() => {
      const renewal = renewLease();
      void renewal.catch(() => {});
      return renewal;
    }, heartbeatIntervalMs);
    timer?.unref?.();
    const stopHeartbeat = () => {
      if (timerCleared) return;
      timerCleared = true;
      clearIntervalFn(timer);
    };

    try {
      const input = await repository.readInput({ jobId: job.id, workerId });
      if (heartbeatFailure) throw heartbeatFailure;
      const snapshot = calculateSnapshotFn({
        ...input,
        algorithm: job.algorithm_version,
      });
      await heartbeatTail;
      await renewLease();
      stopHeartbeat();
      await heartbeatTail;
      if (heartbeatFailure) throw heartbeatFailure;
      const snapshotId = await repository.complete({
        jobId: job.id,
        workerId,
        inputDigest: snapshot.inputDigest,
        results: snapshot,
      });
      return {
        kind: "completed",
        jobId: job.id,
        snapshotId,
        inputDigest: snapshot.inputDigest,
      };
    } catch (error) {
      const safeError = sanitizedError(error, secrets);
      logger.error(safeError.message);
      stopHeartbeat();
      await heartbeatTail;
      try {
        const released = await repository.release({
          jobId: job.id,
          workerId,
          errorText: safeError.message,
        });
        if (released !== true) logger.error("ranking technical failure release was rejected");
      } catch (releaseError) {
        logger.error(sanitizedError(releaseError, secrets).message);
      }
      throw safeError;
    } finally {
      stopHeartbeat();
    }
  }

  async function run({ signal = new AbortController().signal, once = false } = {}) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const result = await runOnce();
        consecutiveFailures = 0;
        if (once) return result;
        if (result.kind === "idle") await sleep(idlePollMs, signal);
      } catch (error) {
        if (once) throw error;
        consecutiveFailures += 1;
        logger.error(sanitizedError(error, secrets).message);
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
