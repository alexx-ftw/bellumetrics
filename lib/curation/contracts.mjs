const ACTIONS = new Set([
  "approve_battle",
  "reject_battle",
  "escalate",
  "merge_commanders",
  "separate_commanders",
]);

const OUTCOMES = new Set([
  "victory",
  "defeat",
  "draw",
  "inconclusive",
  "disputed",
  "unknown",
]);

const ENTITY_TYPES = new Set(["battle", "commander"]);
const ENTITY_ID = /^(?:[a-z][a-z0-9_-]*):[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RATING_FIELD = /(?:elo|rating)/i;

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireOptionalString(value, label) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label);
}

function requireOptionalInteger(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) fail(`${label} must be an integer`);
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown ${label} key: ${key}`);
  }
}

function sortedClone(value) {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedClone(value[key])]),
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function assertNoRatingFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRatingFields(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (RATING_FIELD.test(key)) fail("Elo or rating fields are forbidden");
    assertNoRatingFields(child);
  }
}

function parseEntityReference(value, label, expectedType) {
  const reference = requireObject(value, `${label} entity reference`);
  rejectUnknownKeys(reference, new Set(["type", "id"]), `${label} entity reference`);
  const type = requireString(reference.type, `${label} entity reference type`);
  const id = requireString(reference.id, `${label} entity reference id`);
  if (!ENTITY_TYPES.has(type) || (expectedType && type !== expectedType) || !ENTITY_ID.test(id)) {
    fail(`${label} has an invalid entity reference`);
  }
  return { type, id };
}

function parseBattle(value) {
  const battle = requireObject(value, "battle");
  rejectUnknownKeys(
    battle,
    new Set(["ref", "slug", "title", "startYear", "endYear", "outcome"]),
    "battle",
  );
  const parsed = {
    ref: parseEntityReference(battle.ref, "battle", "battle"),
    slug: requireString(battle.slug, "battle slug"),
    title: requireString(battle.title, "battle title"),
  };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.slug)) {
    fail("battle slug must use lowercase alphanumeric segments separated by hyphens");
  }
  // War Atlas's export suffix is an identifier detail, not an editorial choice.
  if (parsed.ref.id.startsWith("war-atlas:")) {
    const sourceSlug = parsed.ref.id.slice("war-atlas:".length).replaceAll("_", "-");
    if (parsed.slug === sourceSlug || (sourceSlug.endsWith("-b") && parsed.slug === sourceSlug.slice(0, -2))) {
      parsed.slug = sourceSlug;
    }
  }
  const startYear = requireOptionalInteger(battle.startYear, "battle startYear");
  const endYear = requireOptionalInteger(battle.endYear, "battle endYear");
  if (startYear !== undefined) parsed.startYear = startYear;
  if (endYear !== undefined) parsed.endYear = endYear;
  if (startYear !== undefined && endYear !== undefined && endYear < startYear) {
    fail("battle endYear cannot precede startYear");
  }
  if (battle.outcome !== undefined && battle.outcome !== null) {
    if (typeof battle.outcome !== "string" || !OUTCOMES.has(battle.outcome)) {
      fail("battle outcome is invalid");
    }
    parsed.outcome = battle.outcome;
  }
  return parsed;
}

function parseApprovalMutation(value) {
  rejectUnknownKeys(value, new Set(["action", "battle", "commanderRefs", "participants"]), "canonical mutation");
  const commanderRefs = value.commanderRefs;
  if (!Array.isArray(commanderRefs) || commanderRefs.length === 0) {
    fail("canonical mutation commanderRefs must be a non-empty array");
  }
  const participants = value.participants;
  let parsedParticipants;
  if (participants !== undefined && participants !== null) {
    if (!Array.isArray(participants) || participants.length < 2 || participants.length !== commanderRefs.length) fail("participants must align with commanderRefs");
    parsedParticipants = participants.map((item, index) => {
      requireObject(item, "participant");
      rejectUnknownKeys(item, new Set(["ref", "side"]), "participant");
      const ref = parseEntityReference(item.ref, "participant", "commander");
      if (ref.id !== commanderRefs[index]?.id) fail("participant ref must match ordered commanderRefs");
      return { ref, side: requireString(item.side, "participant side").trim() };
    });
    if (new Set(parsedParticipants.map(p => p.ref.id)).size !== participants.length) fail("participants must be distinct");
    if (new Set(parsedParticipants.map(p => p.side)).size !== 2) fail("participants require two distinct sides");
  }
  return {
    ...(parsedParticipants ? { participants: parsedParticipants } : {}),
    action: "approve_battle",
    battle: parseBattle(value.battle),
    commanderRefs: commanderRefs.map((reference, index) => (
      parseEntityReference(reference, `commanderRefs[${index}]`, "commander")
    )),
  };
}

function parseIdentityMutation(value, action) {
  rejectUnknownKeys(value, new Set(["action", "source", "target"]), "canonical mutation");
  const source = parseEntityReference(value.source, "source", "commander");
  const target = parseEntityReference(value.target, "target", "commander");
  if (source.id === target.id) fail("identity mutation has ambiguous identical entity references");
  return { action, source, target };
}

/**
 * Validates a bounded canonical mutation and returns an immutable, key-stable copy.
 * The mutation grammar deliberately has no rating or Elo fields.
 */
export function assertCanonicalMutation(value) {
  const mutation = requireObject(value, "canonicalMutation");
  assertNoRatingFields(mutation);
  const action = requireString(mutation.action, "canonical mutation action");
  let parsed;
  if (action === "approve_battle") {
    parsed = parseApprovalMutation(mutation);
  } else if (action === "merge_commanders" || action === "separate_commanders") {
    parsed = parseIdentityMutation(mutation, action);
  } else {
    fail("canonical mutation has an unsupported action");
  }
  return deepFreeze(sortedClone(parsed));
}

function parseEvidence(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("evidence must contain at least one citation");
  }
  return value.map((item, index) => {
    const evidence = requireObject(item, `evidence[${index}]`);
    const citation = requireString(evidence.citation, `evidence[${index}].citation`);
    const parsed = { citation };
    if (evidence.url !== undefined && evidence.url !== null) {
      const url = requireString(evidence.url, `evidence[${index}].url`);
      try {
        new URL(url);
      } catch {
        fail(`evidence[${index}].url must be a URL`);
      }
      parsed.url = url;
    }
    const locator = requireOptionalString(evidence.locator, `evidence[${index}].locator`);
    if (locator !== undefined) parsed.locator = locator;
    return parsed;
  });
}

/**
 * Parses untrusted agent JSON without coercion. Unknown top-level and evidence
 * fields are deliberately discarded; mutation keys are rejected so only the
 * executable grammar reaches publication.
 */
export function parseAgentDecisionForCase(value, originalCase) {
  const decision = parseAgentDecision(value);
  if (decision.dataRevision !== originalCase.source_revision) fail("dataRevision mismatch");
  if (decision.action !== "approve_battle") return decision;
  const payload = originalCase.payload;
  const mutation = decision.canonicalMutation;
  if (mutation.battle.ref.id !== `war-atlas:${payload.slug}`) fail("battle.ref must preserve the source identifier");
  const commanders = payload.commanders ?? [];
  if (!Array.isArray(commanders)) fail("payload.commanders must be an array");
  if (commanders.length === 0) {
    if (!mutation.participants) fail("participants required for an empty original list");
    return decision;
  }
  if (mutation.participants) fail("participants cannot overwrite original commanders");
  if (mutation.commanderRefs.length !== commanders.length || commanders.some((commander, i) =>
    mutation.commanderRefs[i].id !== `war-atlas:${commander.slug}`)) {
    fail("commanderRefs must preserve exact source identifiers and order");
  }
  const sides = commanders.map(commander => typeof commander.side === "string" ? commander.side.trim() : "");
  if (sides.some(side => !side) || new Set(sides).size !== 2) fail("participants require two original sides; escalate incomplete assignments");
  return decision;
}

export function parseAgentDecision(value) {
  const decision = requireObject(value, "agent decision");
  assertNoRatingFields(decision);
  const action = requireString(decision.action, "action");
  if (!ACTIONS.has(action)) fail("unsupported action");

  const parsed = {
    action,
    evidence: parseEvidence(decision.evidence),
    reason: requireString(decision.reason, "reason"),
    dataRevision: requireString(decision.dataRevision, "dataRevision"),
    promptVersion: requireString(decision.promptVersion, "promptVersion"),
  };

  if (decision.confidence !== undefined && decision.confidence !== null) {
    if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence)) {
      fail("confidence must be a finite number");
    }
    parsed.confidence = decision.confidence;
  }

  const needsMutation = action === "approve_battle"
    || action === "merge_commanders"
    || action === "separate_commanders";
  if (needsMutation) {
    if (decision.canonicalMutation === undefined || decision.canonicalMutation === null) {
      fail("canonicalMutation is required for this action");
    }
    const canonicalMutation = assertCanonicalMutation(decision.canonicalMutation);
    if (canonicalMutation.action !== action) {
      fail("canonicalMutation action must match decision action");
    }
    parsed.canonicalMutation = canonicalMutation;
  } else {
    if (decision.canonicalMutation !== undefined && decision.canonicalMutation !== null) {
      fail("canonicalMutation is not allowed for this action");
    }
    parsed.canonicalMutation = null;
  }

  return deepFreeze(sortedClone(parsed));
}
