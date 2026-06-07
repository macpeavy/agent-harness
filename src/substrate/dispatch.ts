// The dispatch domain contract — the state machine and the published types every
// consumer imports (the loop daemon AGENT-19, the amend leg AGENT-20). ADR 0009
// (registry) / ADR 0008 (amend cycle). This file is the contract; the persistence
// shape lives in ./schema, and the row type is re-exported here so a consumer needs
// one import for "what a dispatch is and how its state moves".

export type { Dispatch, NewDispatch } from "./schema";

/** A dispatch's lifecycle states (ADR 0009). Terminal states have no outgoing edges. */
export const DISPATCH_STATES = [
  "queued",
  "building",
  "review",
  "amending",
  "done",
  "escalated",
  "failed",
] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

/** The ADR 0008 escalation ladder — where a cap-exceeded dispatch was handed. */
export const ESCALATIONS = ["re-decompose", "tier-promote", "attended"] as const;
export type Escalation = (typeof ESCALATIONS)[number];

/** The legs a dispatch's cost is split across (the instrument). */
export const COST_LEGS = ["build", "review", "amend"] as const;
export type CostLeg = (typeof COST_LEGS)[number];

/**
 * The allowed state graph (ADR 0009). A state whose array is empty is terminal —
 * the terminal/non-terminal sets are DERIVED from this, never hardcoded.
 */
export const TRANSITIONS: Record<DispatchState, readonly DispatchState[]> = {
  queued: ["building"],
  building: ["review", "escalated", "failed"],
  review: ["amending", "done", "escalated", "failed"],
  amending: ["review", "escalated", "failed"],
  done: [],
  escalated: [],
  failed: [],
};

/** A state is terminal when it has no outgoing transitions. */
export function isTerminal(state: DispatchState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** The non-terminal states, derived from the transition graph. */
export function nonTerminalStates(): DispatchState[] {
  return DISPATCH_STATES.filter((s) => !isTerminal(s));
}
