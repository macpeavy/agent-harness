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
 * `escalated` is non-terminal — the chief resolves a parked chunk by re-dispatching it on
 * the strong tier (`escalated → dispatched`, tier-promote) or by splitting it into smaller
 * chunks (`escalated → superseded`, re-decompose; the splits are new chunks). Terminal:
 * done, failed, superseded.
 */
export const CHUNK_STATES = ["planned", "dispatched", "done", "escalated", "failed", "superseded"] as const;
export type ChunkState = (typeof CHUNK_STATES)[number];

export const CHUNK_TRANSITIONS: Record<ChunkState, readonly ChunkState[]> = {
  planned: ["dispatched"],
  dispatched: ["done", "escalated", "failed"],
  escalated: ["dispatched", "planned", "superseded"], // tier-promote, rewind, or re-decompose
  done: [],
  failed: [],
  superseded: [], // re-decomposed: retired, its work moved to the replacement chunks
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

/** A dependency edge in a proposed chunk-DAG (`to` depends on `from`). */
export interface DagEdge {
  from: string;
  to: string;
}

/**
 * Validate a whole proposed chunk-DAG up front (the chief's `decompose` writes the lot at
 * once, ADR 0019). Pure — no I/O; the repository's batch write assumes a valid DAG and the
 * FK/unique constraints are the backstop. Returns the first violation as a message, or null
 * if the DAG is sound. Checks: unique chunk ids, no self-edge, every edge endpoint is a
 * known chunk, no duplicate edge, and acyclicity (Kahn's algorithm).
 */
export function validateDag(chunkIds: readonly string[], edges: readonly DagEdge[]): string | null {
  const ids = new Set<string>();
  for (const id of chunkIds) {
    if (ids.has(id)) return `duplicate chunk id ${id}`;
    ids.add(id);
  }

  const seenEdge = new Set<string>();
  const indegree = new Map<string, number>(chunkIds.map((id) => [id, 0]));
  const succ = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to) return `self-edge on chunk ${e.from}`;
    if (!ids.has(e.from)) return `edge references unknown chunk ${e.from}`;
    if (!ids.has(e.to)) return `edge references unknown chunk ${e.to}`;
    const key = `${e.from}->${e.to}`;
    if (seenEdge.has(key)) return `duplicate edge ${key}`;
    seenEdge.add(key);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    succ.set(e.from, [...(succ.get(e.from) ?? []), e.to]);
  }

  // Kahn's: peel roots (indegree 0); if any node never peels, it's in a cycle.
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
  let peeled = 0;
  while (queue.length > 0) {
    const node = queue.shift() as string;
    peeled++;
    for (const next of succ.get(node) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (peeled < ids.size) return "the chunk-DAG has a cycle";

  return null;
}
