import { parseAgentDecision } from "../../lib/curation/contracts.mjs";
import { resolveConsensus } from "../../lib/curation/consensus.mjs";

export const PROPOSER_PROMPT_VERSION = "proposer-v1";
export const REVIEWER_PROMPT_VERSION = "reviewer-v1";

const PROMPT_VERSION_BY_ROLE = {
  proposer: PROPOSER_PROMPT_VERSION,
  reviewer: REVIEWER_PROMPT_VERSION,
};
const ACTIONS_BY_ENTITY_TYPE = {
  battle: new Set(["approve_battle", "reject_battle", "escalate"]),
  commander: new Set(["merge_commanders", "separate_commanders", "escalate"]),
};

function caseContextFromLease(leasedCase) {
  return {
    caseId: leasedCase.id,
    caseKey: leasedCase.case_key,
    entityType: leasedCase.entity_type,
    dataRevision: leasedCase.source_revision,
    payload: leasedCase.payload,
  };
}

function parseDecision(value, { role, leasedCase }) {
  let decision;
  if (typeof value === "string") {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new TypeError(`agent response is not valid JSON: ${error.message}`);
    }
    decision = parseAgentDecision(parsed);
  } else {
    decision = parseAgentDecision(value);
  }
  const promptVersion = PROMPT_VERSION_BY_ROLE[role];
  if (decision.dataRevision !== leasedCase.source_revision) {
    throw new TypeError(
      `${role} dataRevision must equal leased revision ${leasedCase.source_revision}`,
    );
  }
  if (decision.promptVersion !== promptVersion) {
    throw new TypeError(`${role} promptVersion must equal ${promptVersion}`);
  }
  const allowedActions = ACTIONS_BY_ENTITY_TYPE[leasedCase.entity_type];
  if (!allowedActions) {
    throw new TypeError(`unsupported curation entity type: ${leasedCase.entity_type}`);
  }
  if (!allowedActions.has(decision.action)) {
    throw new TypeError(
      `${decision.action} is incompatible with ${leasedCase.entity_type} curation cases`,
    );
  }
  return decision;
}

function latestReview(reviews, role, { leasedCase, model }) {
  let found = null;
  for (const review of reviews) {
    if (review?.review_role === role) found = review;
  }
  if (!found) return null;
  if (found.model !== model) {
    throw new TypeError(`stored ${role} model must equal configured model ${model}`);
  }
  const promptVersion = PROMPT_VERSION_BY_ROLE[role];
  if (found.prompt_version !== promptVersion) {
    throw new TypeError(
      `stored ${role} prompt_version must equal ${promptVersion}`,
    );
  }
  return {
    reviewId: Number.isSafeInteger(found.review_id) && found.review_id > 0
      ? found.review_id
      : null,
    decision: parseDecision(found.decision, { role, leasedCase }),
  };
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
  const message = redact(error instanceof Error ? error.message : error, secrets);
  const result = new Error(message);
  if (error instanceof Error && error.name) result.name = error.name;
  return result;
}

function releaseOutcome(decision) {
  return decision.action === "reject_battle" ? "rejected" : "approved";
}

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

export function createCurationWorker({
  repository,
  runner,
  workerId,
  model,
  leaseSeconds = 300,
  heartbeatIntervalMs = 60_000,
  idlePollMs = 5_000,
  initialRetryMs = 1_000,
  maximumRetryMs = 15 * 60_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  sleep = abortableSleep,
  resolveConsensusFn = resolveConsensus,
  publicationRepository = null,
  executeDecision = async () => {},
  logger = { error() {} },
  secrets = [],
}) {
  if (!repository || typeof repository.lease !== "function") {
    throw new TypeError("repository with lease() is required");
  }
  if (typeof workerId !== "string" || workerId.trim() === "") {
    throw new TypeError("workerId is required");
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new TypeError("model is required");
  }

  async function runOnce() {
    const leasedCase = await repository.lease({ workerId, leaseSeconds });
    if (!leasedCase) return { kind: "idle" };

    let heartbeatFailure = null;
    let heartbeatTail = Promise.resolve();
    let timerCleared = false;

    const renewLease = () => {
      const renewal = heartbeatTail.then(async () => {
        if (heartbeatFailure) throw heartbeatFailure;
        try {
          const renewed = await repository.heartbeat({
            caseId: leasedCase.id,
            workerId,
            leaseSeconds,
          });
          if (renewed !== true) {
            throw new Error("curation lease heartbeat was rejected");
          }
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
    const assertHeartbeat = () => {
      if (heartbeatFailure) throw heartbeatFailure;
    };
    const renewAndAssertLease = async () => {
      await heartbeatTail;
      assertHeartbeat();
      await renewLease();
      assertHeartbeat();
    };
    const releaseLeasedCase = async ({ outcome, errorText }) => {
      const released = await repository.release({
        caseId: leasedCase.id,
        workerId,
        outcome,
        errorText,
      });
      if (released !== true) {
        throw new Error(`curation release for outcome ${outcome} was rejected`);
      }
    };
    const caseContext = caseContextFromLease(leasedCase);

    try {
      const storedReviews = await repository.readReviews({
        caseId: leasedCase.id,
        workerId,
      });
      let proposalRecord = latestReview(storedReviews ?? [], "proposer", { leasedCase, model });
      let reviewRecord = latestReview(storedReviews ?? [], "reviewer", { leasedCase, model });

      if (!proposalRecord) {
        const proposal = parseDecision(await runner.runProposer(caseContext), {
          role: "proposer",
          leasedCase,
        });
        assertHeartbeat();
        const reviewId = await repository.recordReview({
          caseId: leasedCase.id,
          workerId,
          reviewRole: "proposer",
          model,
          promptVersion: PROPOSER_PROMPT_VERSION,
          evidence: proposal.evidence,
          decision: proposal,
        });
        proposalRecord = { reviewId, decision: proposal };
        assertHeartbeat();
      }

      if (!reviewRecord) {
        const review = parseDecision(await runner.runReviewer(caseContext), {
          role: "reviewer",
          leasedCase,
        });
        assertHeartbeat();
        const reviewId = await repository.recordReview({
          caseId: leasedCase.id,
          workerId,
          reviewRole: "reviewer",
          model,
          promptVersion: REVIEWER_PROMPT_VERSION,
          evidence: review.evidence,
          decision: review,
        });
        reviewRecord = { reviewId, decision: review };
        assertHeartbeat();
      }

      const consensus = resolveConsensusFn(
        proposalRecord.decision,
        reviewRecord.decision,
      );
      if (consensus.kind === "execute") {
        if (consensus.decision.canonicalMutation) {
          if (!publicationRepository || typeof publicationRepository.publish !== "function") {
            throw new Error("publication repository is required for canonical mutations");
          }
          if (!Number.isSafeInteger(proposalRecord.reviewId) || proposalRecord.reviewId <= 0
            || !Number.isSafeInteger(reviewRecord.reviewId) || reviewRecord.reviewId <= 0) {
            throw new Error("exact persisted review ids are required for canonical publication");
          }
        }
        await renewAndAssertLease();
        if (consensus.decision.canonicalMutation) {
          stopHeartbeat();
          await heartbeatTail;
          assertHeartbeat();
          await publicationRepository.publish({
            caseId: leasedCase.id,
            workerId,
            proposerReviewId: proposalRecord.reviewId,
            reviewerReviewId: reviewRecord.reviewId,
            model,
          });
        } else {
          await executeDecision({ caseContext, decision: consensus.decision });
          stopHeartbeat();
          await heartbeatTail;
          assertHeartbeat();
          await releaseLeasedCase({
            outcome: releaseOutcome(consensus.decision),
            errorText: null,
          });
        }
      } else {
        stopHeartbeat();
        await renewAndAssertLease();
        await releaseLeasedCase({
          outcome: "awaiting_human",
          errorText: consensus.reason,
        });
      }
      return consensus;
    } catch (error) {
      const safeError = sanitizedError(error, secrets);
      logger.error(safeError.message);
      stopHeartbeat();
      await heartbeatTail;
      try {
        await releaseLeasedCase({
          outcome: "technical_failure",
          errorText: safeError.message,
        });
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
        const delay = Math.min(
          initialRetryMs * (2 ** (consecutiveFailures - 1)),
          maximumRetryMs,
        );
        logger.error(sanitizedError(error, secrets).message);
        await sleep(delay, signal);
      }
    }
    return { kind: "stopped" };
  }

  return { runOnce, run };
}
