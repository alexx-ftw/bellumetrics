import { createHash } from "node:crypto";

import { resolveRankingAlgorithm } from "./config.mjs";

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function requireId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function compareIds(left, right) {
  return left - right;
}

function normalizeStartYear(value) {
  if (value === null) return null;
  if (Number.isSafeInteger(value)) return value;
  throw new TypeError("engagement.start_year must be an integer or null");
}

function rounded(value) {
  const result = Math.round(value * 1e12) / 1e12;
  return Object.is(result, -0) ? 0 : result;
}

function expectedScore(rating, opponentRating) {
  return 1 / (1 + (10 ** ((opponentRating - rating) / 400)));
}

function inputDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function createComponents(commanderIds) {
  const parent = new Map(commanderIds.map((id) => [id, id]));

  function root(id) {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, current);
      id = next;
    }
    return current;
  }

  function connect(left, right) {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot === rightRoot) return;
    parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
  }

  return { connect, root };
}

function normalizeInput({ commanders, engagements, participations }, algorithm) {
  const publishedCommanders = requireArray(commanders, "commanders")
    .filter((commander) => commander?.publication_status === "published")
    .map((commander) => ({ id: requireId(commander.id, "commander.id") }))
    .sort((left, right) => compareIds(left.id, right.id));
  const commanderIds = new Set(publishedCommanders.map(({ id }) => id));
  if (commanderIds.size !== publishedCommanders.length) {
    throw new TypeError("published commander ids must be unique");
  }

  const candidateEngagements = requireArray(engagements, "engagements")
    .filter((engagement) => (
      engagement?.publication_status === "published" && engagement?.elo_eligible === true
    ))
    .map((engagement) => ({
      id: requireId(engagement.id, "engagement.id"),
      startYear: normalizeStartYear(engagement.start_year),
    }))
    .sort((left, right) => {
      if (left.startYear === null && right.startYear !== null) return 1;
      if (left.startYear !== null && right.startYear === null) return -1;
      return (left.startYear - right.startYear) || compareIds(left.id, right.id);
    });
  const engagementIds = new Set(candidateEngagements.map(({ id }) => id));
  if (engagementIds.size !== candidateEngagements.length) {
    throw new TypeError("eligible engagement ids must be unique");
  }

  const candidateParticipations = requireArray(participations, "participations")
    .filter((participation) => engagementIds.has(participation?.engagement_id))
    .map((participation) => ({
      id: requireId(participation.id, "participation.id"),
      engagementId: requireId(participation.engagement_id, "participation.engagement_id"),
      sideId: requireId(participation.engagement_side_id, "participation.engagement_side_id"),
      commanderId: requireId(participation.commander_id, "participation.commander_id"),
      outcome: participation.outcome,
    }))
    .sort((left, right) => compareIds(left.id, right.id));
  const participationIds = new Set(candidateParticipations.map(({ id }) => id));
  if (participationIds.size !== candidateParticipations.length) {
    throw new TypeError("eligible participation ids must be unique");
  }

  const participationsByEngagement = new Map();
  for (const participation of candidateParticipations) {
    const rows = participationsByEngagement.get(participation.engagementId) ?? [];
    rows.push(participation);
    participationsByEngagement.set(participation.engagementId, rows);
  }

  const normalizedEngagements = [];
  const normalizedParticipations = [];
  for (const engagement of candidateEngagements) {
    const rows = participationsByEngagement.get(engagement.id) ?? [];
    if (rows.some(({ commanderId }) => !commanderIds.has(commanderId))) continue;
    if (rows.length < 2) {
      throw new TypeError(`eligible engagement ${engagement.id} must have participants`);
    }

    const sideOutcomes = new Map();
    for (const row of rows) {
      const existing = sideOutcomes.get(row.sideId);
      if (existing !== undefined && existing !== row.outcome) {
        throw new TypeError(`eligible engagement ${engagement.id} has inconsistent side outcomes`);
      }
      sideOutcomes.set(row.sideId, row.outcome);
    }
    const sides = [...sideOutcomes.entries()].sort(([left], [right]) => compareIds(left, right));
    const outcomes = sides.map(([, outcome]) => outcome);
    const validOutcomes = outcomes.length === 2 && (
      (outcomes.includes("victory") && outcomes.includes("defeat"))
      || outcomes.every((outcome) => outcome === "draw")
    );
    if (!validOutcomes || outcomes.some((outcome) => !(outcome in algorithm.scores))) {
      throw new TypeError(`eligible engagement ${engagement.id} has unsupported outcomes`);
    }
    if (new Set(rows.map(({ commanderId }) => commanderId)).size !== rows.length) {
      throw new TypeError(`eligible engagement ${engagement.id} repeats a commander`);
    }

    normalizedEngagements.push(engagement);
    normalizedParticipations.push(...rows);
  }

  return {
    commanders: publishedCommanders,
    engagements: normalizedEngagements,
    participations: normalizedParticipations,
  };
}

export function calculateSnapshot({
  commanders,
  engagements,
  participations,
  algorithm,
}) {
  const config = resolveRankingAlgorithm(algorithm);
  const input = normalizeInput({ commanders, engagements, participations }, config);
  const ratings = new Map(input.commanders.map(({ id }) => [id, config.initialRating]));
  const components = createComponents([...ratings.keys()]);
  const byEngagement = new Map();
  for (const participation of input.participations) {
    const rows = byEngagement.get(participation.engagementId) ?? [];
    rows.push(participation);
    byEngagement.set(participation.engagementId, rows);
  }

  const battleDeltas = [];
  for (const engagement of input.engagements) {
    const rows = byEngagement.get(engagement.id);
    const sides = new Map();
    for (const row of rows) {
      const side = sides.get(row.sideId) ?? [];
      side.push(row);
      sides.set(row.sideId, side);
    }
    const sideEntries = [...sides.entries()].sort(([left], [right]) => compareIds(left, right));
    const before = new Map(rows.map(({ commanderId }) => [commanderId, ratings.get(commanderId)]));
    const changes = new Map();

    for (const [sideId, sideRows] of sideEntries) {
      const opponentRows = sideEntries
        .filter(([opponentSideId]) => opponentSideId !== sideId)
        .flatMap(([, opponentSideRows]) => opponentSideRows);
      const opponentRating = opponentRows.reduce(
        (total, row) => total + before.get(row.commanderId),
        0,
      ) / opponentRows.length;
      for (const row of sideRows) {
        const score = config.scores[row.outcome];
        const delta = rounded(
          config.kFactor * (score - expectedScore(before.get(row.commanderId), opponentRating)),
        );
        changes.set(row.commanderId, delta);
        for (const opponent of opponentRows) {
          components.connect(row.commanderId, opponent.commanderId);
        }
      }
    }

    for (const row of rows) {
      const ratingBefore = before.get(row.commanderId);
      const delta = changes.get(row.commanderId);
      const ratingAfter = rounded(ratingBefore + delta);
      ratings.set(row.commanderId, ratingAfter);
      battleDeltas.push({
        engagementId: engagement.id,
        participationId: row.id,
        commanderId: row.commanderId,
        ratingBefore,
        ratingAfter,
        delta,
        score: config.scores[row.outcome],
      });
    }
  }

  const ranked = [...ratings.entries()]
    .sort(([leftId, leftRating], [rightId, rightRating]) => (
      (rightRating - leftRating) || compareIds(leftId, rightId)
    ));

  return {
    ratings: ranked.map(([commanderId, rating], index) => ({
      commanderId,
      rating,
      rank: index + 1,
      componentId: `component:${components.root(commanderId)}`,
    })),
    battleDeltas,
    inputDigest: inputDigest({
      algorithm: config,
      commanders: input.commanders,
      engagements: input.engagements,
      participations: input.participations,
    }),
  };
}
