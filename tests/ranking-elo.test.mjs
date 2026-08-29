import assert from "node:assert/strict";
import test from "node:test";

import { calculateSnapshot } from "../lib/ranking/elo.mjs";

function commander(id, publicationStatus = "published") {
  return { id, publication_status: publicationStatus };
}

function engagement(
  id,
  startYear,
  { eloEligible = true, publicationStatus = "published" } = {},
) {
  return {
    id,
    start_year: startYear,
    elo_eligible: eloEligible,
    publication_status: publicationStatus,
  };
}

function participation(id, engagementId, sideId, commanderId, outcome) {
  return {
    id,
    engagement_id: engagementId,
    engagement_side_id: sideId,
    commander_id: commanderId,
    outcome,
  };
}

function calculate(input) {
  return calculateSnapshot({ ...input, algorithm: "elo-v1" });
}

test("elo-v1 starts at 1500 and applies K=32 win/loss scores", () => {
  const snapshot = calculate({
    commanders: [commander(1), commander(2)],
    engagements: [engagement(10, 1815)],
    participations: [
      participation(101, 10, 1001, 1, "victory"),
      participation(102, 10, 1002, 2, "defeat"),
    ],
  });

  assert.deepEqual(snapshot.ratings, [
    { commanderId: 1, rating: 1516, rank: 1, componentId: "component:1" },
    { commanderId: 2, rating: 1484, rank: 2, componentId: "component:1" },
  ]);
  assert.deepEqual(snapshot.battleDeltas, [
    {
      engagementId: 10,
      participationId: 101,
      commanderId: 1,
      ratingBefore: 1500,
      ratingAfter: 1516,
      delta: 16,
      score: 1,
    },
    {
      engagementId: 10,
      participationId: 102,
      commanderId: 2,
      ratingBefore: 1500,
      ratingAfter: 1484,
      delta: -16,
      score: 0,
    },
  ]);
  assert.match(snapshot.inputDigest, /^sha256:[a-f0-9]{64}$/);
});

test("draws use a score of 0.5", () => {
  const snapshot = calculate({
    commanders: [commander(8), commander(9)],
    engagements: [engagement(30, 1648)],
    participations: [
      participation(301, 30, 3001, 8, "draw"),
      participation(302, 30, 3002, 9, "draw"),
    ],
  });

  assert.deepEqual(snapshot.ratings, [
    { commanderId: 8, rating: 1500, rank: 1, componentId: "component:8" },
    { commanderId: 9, rating: 1500, rank: 2, componentId: "component:8" },
  ]);
  assert.deepEqual(snapshot.battleDeltas.map(({ score, delta }) => ({ score, delta })), [
    { score: 0.5, delta: 0 },
    { score: 0.5, delta: 0 },
  ]);
});

test("orders by start_year nulls last, engagement id, then participation id", () => {
  const input = {
    commanders: [commander(3), commander(1), commander(2)],
    engagements: [
      engagement(5, null),
      engagement(20, 100),
      engagement(10, 100),
    ],
    participations: [
      participation(52, 5, 502, 1, "defeat"),
      participation(22, 20, 202, 2, "defeat"),
      participation(12, 10, 102, 3, "defeat"),
      participation(51, 5, 501, 3, "victory"),
      participation(21, 20, 201, 1, "victory"),
      participation(11, 10, 101, 2, "victory"),
    ],
  };

  const snapshot = calculate(input);
  const permuted = calculate({
    commanders: [...input.commanders].reverse(),
    engagements: [...input.engagements].reverse(),
    participations: [...input.participations].reverse(),
  });

  assert.deepEqual(
    snapshot.battleDeltas.map(({ engagementId, participationId }) => [
      engagementId,
      participationId,
    ]),
    [[10, 11], [10, 12], [20, 21], [20, 22], [5, 51], [5, 52]],
  );
  assert.deepEqual(permuted, snapshot);
});

test("assigns deterministic IDs to disconnected and isolated components", () => {
  const snapshot = calculate({
    commanders: [commander(5), commander(4), commander(3), commander(2), commander(1)],
    engagements: [engagement(10, 100), engagement(20, 200)],
    participations: [
      participation(101, 10, 1001, 1, "victory"),
      participation(102, 10, 1002, 2, "defeat"),
      participation(201, 20, 2001, 3, "victory"),
      participation(202, 20, 2002, 4, "defeat"),
    ],
  });

  assert.deepEqual(
    snapshot.ratings
      .toSorted((left, right) => left.commanderId - right.commanderId)
      .map(({ commanderId, componentId }) => [commanderId, componentId]),
    [
      [1, "component:1"],
      [2, "component:1"],
      [3, "component:3"],
      [4, "component:3"],
      [5, "component:5"],
    ],
  );
});

test("excludes unpublished commanders and non-published or ineligible engagements", () => {
  const baseline = calculate({
    commanders: [commander(1), commander(2)],
    engagements: [engagement(10, 100)],
    participations: [
      participation(101, 10, 1001, 1, "victory"),
      participation(102, 10, 1002, 2, "defeat"),
    ],
  });
  const withExcludedRows = calculate({
    commanders: [commander(1), commander(2), commander(3, "pending")],
    engagements: [
      engagement(10, 100),
      engagement(20, 200, { publicationStatus: "pending" }),
      engagement(30, 300, { eloEligible: false }),
      engagement(40, 400),
    ],
    participations: [
      participation(101, 10, 1001, 1, "victory"),
      participation(102, 10, 1002, 2, "defeat"),
      participation(201, 20, 2001, 2, "victory"),
      participation(202, 20, 2002, 1, "defeat"),
      participation(301, 30, 3001, 2, "victory"),
      participation(302, 30, 3002, 1, "defeat"),
      participation(401, 40, 4001, 3, "victory"),
      participation(402, 40, 4002, 1, "defeat"),
    ],
  });

  assert.deepEqual(withExcludedRows, baseline);
});

test("rejects unknown algorithms and malformed eligible outcomes", () => {
  assert.throws(
    () => calculateSnapshot({
      commanders: [],
      engagements: [],
      participations: [],
      algorithm: "elo-v2",
    }),
    /unsupported ranking algorithm/i,
  );

  assert.throws(
    () => calculate({
      commanders: [commander(1), commander(2)],
      engagements: [engagement(10, 100)],
      participations: [
        participation(101, 10, 1001, 1, "victory"),
        participation(102, 10, 1002, 2, "unknown"),
      ],
    }),
    /eligible engagement 10.*outcomes/i,
  );
});
