import type {
  AgentDecision,
  BattleReference,
  CommanderReference,
  RejectBattleDecision,
} from "../lib/curation/contracts.mjs";

const battle: BattleReference = { type: "battle", id: "war-atlas:waterloo" };
const commander: CommanderReference = { type: "commander", id: "wikidata:Q517" };

const approved: AgentDecision = {
  action: "approve_battle",
  evidence: [{ citation: "Chandler, p. 1021" }],
  reason: "The sources support this engagement.",
  canonicalMutation: {
    action: "approve_battle",
    battle: { ref: battle, slug: "waterloo", title: "Battle of Waterloo" },
    commanderRefs: [commander],
  },
  dataRevision: "war-atlas-2026-08-24",
  promptVersion: "curation-v1",
};

const rejected: AgentDecision = {
  action: "reject_battle",
  evidence: [{ citation: "Chandler, p. 1021" }],
  reason: "The sources do not establish the imported battle.",
  canonicalMutation: null,
  dataRevision: "war-atlas-2026-08-24",
  promptVersion: "curation-v1",
};

const merged: AgentDecision = {
  action: "merge_commanders",
  evidence: [{ citation: "Oxford DNB" }],
  reason: "Both records identify the same commander.",
  canonicalMutation: {
    action: "merge_commanders",
    source: commander,
    target: { type: "commander", id: "wikidata:Q152245" },
  },
  dataRevision: "war-atlas-2026-08-24",
  promptVersion: "curation-v1",
};

void approved;
void rejected;
void merged;

const approvalWithBattleCommander: AgentDecision = {
  action: "approve_battle",
  evidence: [{ citation: "Chandler, p. 1021" }],
  reason: "Invalid reference pairing.",
  canonicalMutation: {
    action: "approve_battle",
    battle: { ref: battle, slug: "waterloo", title: "Battle of Waterloo" },
    // @ts-expect-error approval mutations only accept commander references.
    commanderRefs: [battle],
  },
  dataRevision: "war-atlas-2026-08-24",
  promptVersion: "curation-v1",
};

const mergeWithBattleSource: AgentDecision = {
  action: "merge_commanders",
  evidence: [{ citation: "Oxford DNB" }],
  reason: "Invalid reference pairing.",
  canonicalMutation: {
    action: "merge_commanders",
    // @ts-expect-error identity mutations only accept commander references.
    source: battle,
    target: commander,
  },
  dataRevision: "war-atlas-2026-08-24",
  promptVersion: "curation-v1",
};

const rejectionWithMutation: RejectBattleDecision = {
  action: "reject_battle",
  evidence: [{ citation: "Chandler, p. 1021" }],
  reason: "Invalid action/mutation pairing.",
  // @ts-expect-error reject decisions cannot carry an executable mutation.
  canonicalMutation: {
    action: "approve_battle",
    battle: { ref: battle, slug: "waterloo", title: "Battle of Waterloo" },
    commanderRefs: [commander],
  },
  dataRevision: "war-atlas-2026-08-24",
  promptVersion: "curation-v1",
};

void approvalWithBattleCommander;
void mergeWithBattleSource;
void rejectionWithMutation;
