import test from "node:test";
import assert from "node:assert/strict";

import {
  commanders,
  rankCommanders,
  shortestPath,
} from "../lib/commanders.mjs";

test("historical ranking orders commanders from highest to lowest score", () => {
  const ranked = rankCommanders("historical");
  assert.ok(ranked.length >= 20);
  assert.equal(ranked[0].score >= ranked[1].score, true);
  assert.equal(ranked.at(-2).score >= ranked.at(-1).score, true);
});

test("adjusted ranking uses the adjusted rating", () => {
  const ranked = rankCommanders("adjusted");
  assert.equal(ranked.every((entry) => entry.score === entry.ratings.adjusted), true);
});

test("shortestPath returns two commanders for a direct confrontation", () => {
  assert.deepEqual(
    shortestPath("napoleon-bonaparte", "mikhail-kutuzov").map((commander) => commander.id),
    ["napoleon-bonaparte", "mikhail-kutuzov"],
  );
});

test("shortestPath finds the hand-checked indirect connection", () => {
  assert.deepEqual(
    shortestPath("napoleon-bonaparte", "tipu-sultan").map((commander) => commander.id),
    ["napoleon-bonaparte", "arthur-wellesley", "tipu-sultan"],
  );
});

test("shortestPath returns the commander itself for identical endpoints", () => {
  assert.deepEqual(
    shortestPath("yi-sun-sin", "yi-sun-sin").map((commander) => commander.id),
    ["yi-sun-sin"],
  );
});

test("shortestPath returns null when either commander does not exist", () => {
  assert.equal(shortestPath("napoleon-bonaparte", "unknown-person"), null);
  assert.equal(shortestPath("unknown-person", "napoleon-bonaparte"), null);
});

test("every seeded commander exposes confidence and four rating dimensions", () => {
  for (const commander of commanders) {
    assert.equal(typeof commander.confidence, "number");
    assert.deepEqual(Object.keys(commander.ratings).sort(), [
      "adjusted",
      "historical",
      "strategic",
      "tactical",
    ]);
  }
});
