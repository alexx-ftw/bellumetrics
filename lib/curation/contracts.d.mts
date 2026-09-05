export type DecisionAction =
  | "approve_battle"
  | "reject_battle"
  | "escalate"
  | "merge_commanders"
  | "separate_commanders";

export interface BattleReference {
  readonly type: "battle";
  readonly id: string;
}

export interface CommanderReference {
  readonly type: "commander";
  readonly id: string;
}

export type EntityReference = BattleReference | CommanderReference;

export interface Citation {
  readonly citation: string;
  readonly url?: string;
  readonly locator?: string;
}

export interface ApproveBattleMutation {
  readonly action: "approve_battle";
  readonly battle: {
    readonly ref: BattleReference;
    readonly slug: string;
    readonly title: string;
    readonly startYear?: number;
    readonly endYear?: number;
    readonly outcome?: "victory" | "defeat" | "draw" | "inconclusive" | "disputed" | "unknown";
  };
  readonly commanderRefs: readonly CommanderReference[];
  readonly participants?: readonly { readonly ref: CommanderReference; readonly side: string }[];
}

export interface MergeCommandersMutation {
  readonly action: "merge_commanders";
  readonly source: CommanderReference;
  readonly target: CommanderReference;
}

export interface SeparateCommandersMutation {
  readonly action: "separate_commanders";
  readonly source: CommanderReference;
  readonly target: CommanderReference;
}

export type IdentityMutation = MergeCommandersMutation | SeparateCommandersMutation;
export type CanonicalMutation = ApproveBattleMutation | IdentityMutation;

interface AgentDecisionBase {
  readonly evidence: readonly Citation[];
  readonly reason: string;
  readonly dataRevision: string;
  readonly promptVersion: string;
  readonly confidence?: number;
}

export interface ApproveBattleDecision extends AgentDecisionBase {
  readonly action: "approve_battle";
  readonly canonicalMutation: ApproveBattleMutation;
}

export interface RejectBattleDecision extends AgentDecisionBase {
  readonly action: "reject_battle";
  readonly canonicalMutation: null;
}

export interface EscalateDecision extends AgentDecisionBase {
  readonly action: "escalate";
  readonly canonicalMutation: null;
}

export interface MergeCommandersDecision extends AgentDecisionBase {
  readonly action: "merge_commanders";
  readonly canonicalMutation: MergeCommandersMutation;
}

export interface SeparateCommandersDecision extends AgentDecisionBase {
  readonly action: "separate_commanders";
  readonly canonicalMutation: SeparateCommandersMutation;
}

export type AgentDecision =
  | ApproveBattleDecision
  | RejectBattleDecision
  | EscalateDecision
  | MergeCommandersDecision
  | SeparateCommandersDecision;

export function assertCanonicalMutation(value: unknown): CanonicalMutation;
export function parseAgentDecision(value: unknown): AgentDecision;
export function parseAgentDecisionForCase(value: unknown, originalCase: { source_revision: string; payload: { slug: string; commanders?: readonly { slug: string; side?: string }[] } }): AgentDecision;
