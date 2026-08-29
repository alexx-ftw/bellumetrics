import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveConsensus } from "../lib/curation/consensus.mjs";

const fixture = (name) => readFile(
  new URL(`./fixtures/curation/${name}.json`, import.meta.url),
  "utf8",
).then(JSON.parse);

test("executes structurally identical approvals despite key order and confidence differences", async () => {
  const result = resolveConsensus(
    await fixture("agreement-proposal"),
    await fixture("agreement-review"),
  );

  assert.deepEqual(result, {
    kind: "execute",
    decision: {
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
    },
  });
});

test("escalates a disagreement without applying a confidence threshold", async () => {
  const result = resolveConsensus(
    await fixture("agreement-proposal"),
    await fixture("disagreement-review"),
  );

  assert.equal(result.kind, "escalate");
  assert.equal(result.reason, "action_disagreement");
  assert.equal(result.proposal.action, "approve_battle");
  assert.equal(result.review.action, "reject_battle");
});

test("escalates explicit escalation and malformed or uncited output", async () => {
  const proposal = await fixture("agreement-proposal");
  const escalation = {
    action: "escalate",
    evidence: [{ citation: "Conflicting sources require a curator." }],
    reason: "The source conflict cannot be resolved automatically.",
    dataRevision: "war-atlas-2026-08-24",
    promptVersion: "curation-v1",
  };

  assert.equal(resolveConsensus(proposal, escalation).reason, "explicit_escalation");
  assert.equal(
    resolveConsensus(proposal, await fixture("insufficient-evidence")).reason,
    "malformed_decision",
  );
  assert.equal(
    resolveConsensus(proposal, await fixture("malformed-output")).reason,
    "malformed_decision",
  );
});

test("escalates distinct canonical mutations and identity ambiguity", async () => {
  const proposal = await fixture("agreement-proposal");
  const changedReview = await fixture("agreement-review");
  changedReview.canonicalMutation.battle.outcome = "draw";
  assert.equal(resolveConsensus(proposal, changedReview).reason, "mutation_disagreement");

  const ambiguousMerge = await fixture("merge");
  ambiguousMerge.canonicalMutation.target = ambiguousMerge.canonicalMutation.source;
  assert.equal(resolveConsensus(ambiguousMerge, await fixture("merge")).reason, "malformed_decision");
});

test("executes matching, unambiguous separation decisions", async () => {
  const separation = await fixture("separation");
  const result = resolveConsensus(separation, separation);

  assert.equal(result.kind, "execute");
  assert.equal(result.decision.action, "separate_commanders");
});
