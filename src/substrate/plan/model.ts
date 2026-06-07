// The plan domain (the engine layer) — the feature/chunk state machines and the
// published types. Pure logic and types: no I/O, no ORM imports. The repository and the
// service layer build on this. ADR 0019 (planning context) / ADR 0014 (the chunk spec).
// The persistence shape lives in ./schema; its row types are re-exported here so the
// model is one import for "what a feature/chunk/edge is and how its state moves".

export type { Feature, NewFeature, Chunk, NewChunk, Edge, NewEdge } from "./schema";

/** A feature's lifecycle: the chief authors the chunk-DAG, then chunks execute. */
export const FEATURE_STATES = ["planning", "ready", "building", "done"] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];

export const FEATURE_TRANSITIONS: Record<FeatureState, readonly FeatureState[]> = {
  planning: ["ready"], // the chunk-DAG is authored
  ready: ["building"], // chunks start dispatching (owner-approved)
  building: ["done"], // all chunks reached done
  done: [],
};

/**
 * A chunk's lifecycle. Mirrors the dispatch registry's escalate-is-pausable model:
 * `escalated` is non-terminal — a parked chunk the chief re-dispatches (tier-promote)
 * or sends back to `planned` (re-decompose). Terminal: done, failed.
 */
export const CHUNK_STATES = ["planned", "dispatched", "done", "escalated", "failed"] as const;
export type ChunkState = (typeof CHUNK_STATES)[number];

export const CHUNK_TRANSITIONS: Record<ChunkState, readonly ChunkState[]> = {
  planned: ["dispatched"],
  dispatched: ["done", "escalated", "failed"],
  escalated: ["dispatched", "planned"], // rewoken: tier-promote re-dispatch, or re-decompose
  done: [],
  failed: [],
};

/** Which build tier a chunk is hinted for (ADR 0014). */
export const TIER_HINTS = ["cheap", "strong"] as const;
export type TierHint = (typeof TIER_HINTS)[number];

/** The terminal outcome a dispatch flows back onto its chunk (ADR 0019). */
export const CHUNK_OUTCOMES = ["done", "escalated", "failed"] as const;
export type ChunkOutcome = (typeof CHUNK_OUTCOMES)[number];

/** A state is terminal when it has no outgoing transitions. */
export function isChunkTerminal(state: ChunkState): boolean {
  return CHUNK_TRANSITIONS[state].length === 0;
}
