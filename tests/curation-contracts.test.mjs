import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertCanonicalMutation,
  parseAgentDecision,
} from "../lib/curation/contracts.mjs";

const fixture = (name) => readFile(
  new URL(`./fixtures/curation/${name}.json`, import.meta.url),
  "utf8",
).then(JSON.parse);

test("parses a cited approval into a detached immutable decision", async () => {
  const input = await fixture("agreement-proposal");
  const decision = parseAgentDecision(input);

  assert.deepEqual(decision, {
    action: "approve_battle",
    evidence: [{
      citation: "Chandler, The Campaigns of Napoleon, p. 1021",
      url: "https://example.test/chandler-waterloo",
      locator: "p. 1021",
    }],
    reason: "The cited source identifies the battle and both commanders.",
    canonicalMutation: {
      action: "approve_battle",
      battle: {
        ref: { type: "battle", id: "war-atlas:waterloo" },
        slug: "waterloo",
        title: "Battle of Waterloo",
        startYear: 1815,
        endYear: 1815,
        outcome: "victory",
      },
      commanderRefs: [
        { type: "commander", id: "wikidata:Q517" },
        { type: "commander", id: "wikidata:Q152245" },
      ],
    },
    dataRevision: "war-atlas-2026-08-24",
    promptVersion: "curation-v1",
    confidence: 0.92,
  });
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.canonicalMutation.battle), true);
  assert.throws(() => {
    decision.reason = "mutated";
  }, TypeError);
  input.canonicalMutation.battle.title = "Changed after parsing";
  assert.equal(decision.canonicalMutation.battle.title, "Battle of Waterloo");
});

test("normalizes nullable Structured Outputs fields to absent optional values", async () => {
  const input = await fixture("agreement-proposal");
  input.evidence[0].url = null;
  input.evidence[0].locator = null;
  input.confidence = null;
  input.canonicalMutation.battle.startYear = null;
  input.canonicalMutation.battle.endYear = null;
  input.canonicalMutation.battle.outcome = null;

  const decision = parseAgentDecision(input);

  assert.deepEqual(decision.evidence, [{
    citation: "Chandler, The Campaigns of Napoleon, p. 1021",
  }]);
  assert.equal(Object.hasOwn(decision, "confidence"), false);
  assert.deepEqual(decision.canonicalMutation.battle, {
    ref: { type: "battle", id: "war-atlas:waterloo" },
    slug: "waterloo",
    title: "Battle of Waterloo",
  });
});

test("rejects unsupported actions and invalid citations", async () => {
  await assert.rejects(
    fixture("malformed-output").then(parseAgentDecision),
    /unsupported action/i,
  );
  await assert.rejects(
    fixture("insufficient-evidence").then(parseAgentDecision),
    /evidence.*citation/i,
  );
});

test("rejects malformed entity references and every rating mutation", async () => {
  const decision = await fixture("agreement-proposal");
  decision.canonicalMutation.battle.ref.id = "not a valid reference";
  assert.throws(() => parseAgentDecision(decision), /entity reference/i);

  const mutation = (await fixture("agreement-proposal")).canonicalMutation;
  mutation.battle.elo = 1900;
  assert.throws(() => assertCanonicalMutation(mutation), /Elo.*rating/i);

  const agentSuppliedRating = await fixture("agreement-proposal");
  agentSuppliedRating.elo = 1900;
  assert.throws(() => parseAgentDecision(agentSuppliedRating), /Elo.*rating/i);
});

test("requires full audited context for approvals and merges", async () => {
  const approval = await fixture("agreement-proposal");
  delete approval.reason;
  assert.throws(() => parseAgentDecision(approval), /reason/i);

  const merge = await fixture("merge");
  delete merge.canonicalMutation;
  assert.throws(() => parseAgentDecision(merge), /canonicalMutation/i);
});

test("rejects free-form canonical mutations", async () => {
  const mutation = (await fixture("agreement-proposal")).canonicalMutation;
  mutation.sql = "update commanders set rating = 5000";
  assert.throws(() => assertCanonicalMutation(mutation), /unknown canonical mutation key/i);
});
