import { parseAgentDecision } from "./contracts.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parsedOrNull(value) {
  try {
    return parseAgentDecision(value);
  } catch {
    return null;
  }
}

function escalate(reason, proposal, review) {
  return deepFreeze({ kind: "escalate", reason, proposal, review });
}

/**
 * Resolves only auditable, compatible decisions. Confidence is recorded but
 * intentionally has no role in consensus.
 */
export function resolveConsensus(proposal, review) {
  const parsedProposal = parsedOrNull(proposal);
  const parsedReview = parsedOrNull(review);
  if (!parsedProposal || !parsedReview) {
    return escalate("malformed_decision", parsedProposal, parsedReview);
  }
  if (parsedProposal.action === "escalate" || parsedReview.action === "escalate") {
    return escalate("explicit_escalation", parsedProposal, parsedReview);
  }
  if (parsedProposal.action !== parsedReview.action) {
    return escalate("action_disagreement", parsedProposal, parsedReview);
  }
  if (stableStringify(parsedProposal.canonicalMutation)
    !== stableStringify(parsedReview.canonicalMutation)) {
    return escalate("mutation_disagreement", parsedProposal, parsedReview);
  }
  return deepFreeze({ kind: "execute", decision: parsedProposal });
}
