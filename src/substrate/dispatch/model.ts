// The dispatch domain (the engine layer) — the state machine and the published types.
// Pure logic and types: no I/O, no ORM imports. The repository and the service layer
// build on this. ADR 0009 (registry) / ADR 0008 (amend cycle). The persistence shape
// lives in ./schema; its row type is re-exported here so the model is one import for
// "what a dispatch is and how its state moves".

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
  "abandoned",
] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

/** Why a dispatch parked — the escalation reasons in the ADR 0023 failure taxonomy. The
 *  classic ladder (re-decompose / tier-promote / attended) plus the two non-success build
 *  outcomes that used to hard-fail: `no-op` (builder changed nothing) and `error` (a leg threw).
 *  Every parked reason is chief-routable (status → redecompose / promote / address). */
export const ESCALATIONS = ["re-decompose", "tier-promote", "attended", "no-op", "error"] as const;
export type Escalation = (typeof ESCALATIONS)[number];

/** The legs a dispatch's cost is split across (the instrument). */
export const COST_LEGS = ["build", "review", "amend"] as const;
export type CostLeg = (typeof COST_LEGS)[number];

/**
 * The build tier a dispatch runs on (ADR 0013/0014): the cheap builder by default, or the
 * strong builder for a tier-hinted or tier-promoted chunk. The dispatch context's own
 * notion; the plan's `TierHint` maps onto it (same values, each context owns its type).
 */
export const BUILD_TIERS = ["cheap", "strong"] as const;
export type BuildTier = (typeof BUILD_TIERS)[number];

/**
 * The allowed state graph (ADR 0009). A state whose array is empty is terminal —
 * the terminal/non-terminal sets are DERIVED from this, never hardcoded.
 */
export const TRANSITIONS: Record<DispatchState, readonly DispatchState[]> = {
  queued: ["building"],
  building: ["review", "escalated", "failed"],
  review: ["amending", "done", "escalated", "failed"],
  amending: ["review", "escalated", "failed"],
  // `done` is a RESTING state, reopenable only by owner review (ADR 0020 slice 4b): the
  // owner's PR comments reopen a merged chunk's dispatch (`done → amending`) to amend the
  // fix back into session-main. It's the same shape as `escalated` — non-terminal but
  // PARKED: resumeIncomplete() surfaces it, and the daemon SKIPS it (never auto-drives a
  // done dispatch) until the external reopen signal moves it to `amending`. The only
  // mover is reopenForReview; the normal build→review→merge path leaves it at rest here.
  done: ["amending"],
  // `escalated` is a PAUSED state, not terminal: a cap-exceeded dispatch parks here
  // and is rewoken on resolution — re-decompose / tier-promote / attended all re-enter
  // at `building` — or is abandoned to `failed` (ADR 0008). Because it's non-terminal,
  // resumeIncomplete() surfaces it; the daemon parks it until an external rewake.
  escalated: ["building", "failed"],
  failed: [],
  // operator kill switch (the abandon CLI) — terminal, reached by a deliberate force-transition
  // (DispatchRepository.abandonMany), not a graph edge: an operator kills a dispatch from any state.
  abandoned: [],
};

/** A state is terminal when it has no outgoing transitions. */
export function isTerminal(state: DispatchState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** The non-terminal states, derived from the transition graph. */
export function nonTerminalStates(): DispatchState[] {
  return DISPATCH_STATES.filter((s) => !isTerminal(s));
}
