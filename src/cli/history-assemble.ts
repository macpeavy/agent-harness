// The history assembly layer — transform a FeatureGraph into render-ready FeatureHistory.
// Given the persisted feature/session/chunk/dispatch graph, synthesize per-chunk dispatch timelines
// (events), compute cost totals, and collect escalations. Pure: no I/O, no side effects.

import type { Chunk, Edge, Feature, FeatureGraph, Session } from "../substrate/plan";
import type { Dispatch } from "../substrate/dispatch";

export interface DispatchEvent {
  kind: "build" | "review" | "amend" | "escalated" | "done" | "failed";
  timestampMs: number;
  costUsd: number;
  escalationKind: string | null;
  escalationReason: string | null;
}

export interface ChunkHistory {
  chunk: Chunk;
  dependsOn: string[];
  dispatch: Dispatch | null;
  events: DispatchEvent[];
}

export interface SessionHistory {
  session: Session;
  chunks: ChunkHistory[];
  totalCostUsd: number;
  escalations: EscalationRecord[];
}

export interface EscalationRecord {
  chunkId: string;
  dispatchId: string;
  kind: string;
  reason: string | null;
}

export interface FeatureHistory {
  feature: Feature;
  sessions: SessionHistory[];
  totalCostUsd: number;
  totalEscalations: number;
  chiefCostNote: string;
}

/** Synthesize dispatch events from a dispatch row. Emits in order: build, review, amend, escalated, terminal.
 *  Uses createdAt for build, updatedAt for all others. costUsd sums the leg costs. */
function synthesizeEvents(dispatch: Dispatch): DispatchEvent[] {
  const events: DispatchEvent[] = [];

  const buildCost = dispatch.buildCostUsd ?? 0;
  events.push({
    kind: "build",
    timestampMs: dispatch.createdAt,
    costUsd: buildCost,
    escalationKind: null,
    escalationReason: null,
  });

  if ((dispatch.reviewCostUsd ?? 0) > 0) {
    events.push({
      kind: "review",
      timestampMs: dispatch.updatedAt,
      costUsd: dispatch.reviewCostUsd ?? 0,
      escalationKind: null,
      escalationReason: null,
    });
  }

  if ((dispatch.amendCostUsd ?? 0) > 0) {
    events.push({
      kind: "amend",
      timestampMs: dispatch.updatedAt,
      costUsd: dispatch.amendCostUsd ?? 0,
      escalationKind: null,
      escalationReason: null,
    });
  }

  if (dispatch.escalated != null) {
    events.push({
      kind: "escalated",
      timestampMs: dispatch.updatedAt,
      costUsd: 0,
      escalationKind: dispatch.escalated,
      escalationReason: dispatch.escalationReason ?? null,
    });
  }

  if (dispatch.state === "done") {
    events.push({
      kind: "done",
      timestampMs: dispatch.updatedAt,
      costUsd: 0,
      escalationKind: null,
      escalationReason: null,
    });
  } else if (dispatch.state === "failed" || dispatch.state === "abandoned") {
    events.push({
      kind: "failed",
      timestampMs: dispatch.updatedAt,
      costUsd: 0,
      escalationKind: null,
      escalationReason: null,
    });
  }

  return events;
}

/** Build dependsOn list for a chunk: the fromChunkIds of edges where toChunkId === chunk.id. */
function collectDependencies(chunkId: string, edges: Edge[]): string[] {
  return edges.filter((e) => e.toChunkId === chunkId).map((e) => e.fromChunkId);
}

/** Assemble a FeatureHistory from a FeatureGraph. Pure transformation. */
export function assembleHistory(graph: FeatureGraph): FeatureHistory {
  const sessions: SessionHistory[] = [];
  let featureTotalCost = 0;
  let featureTotalEscalations = 0;

  for (const sessionGraph of graph.sessions) {
    const chunks: ChunkHistory[] = [];
    const escalations: EscalationRecord[] = [];
    let sessionTotalCost = 0;

    for (const chunkGraph of sessionGraph.chunks) {
      const dependsOn = collectDependencies(chunkGraph.chunk.id, sessionGraph.edges);
      const events = chunkGraph.dispatch ? synthesizeEvents(chunkGraph.dispatch) : [];

      let chunkCost = 0;
      for (const event of events) {
        chunkCost += event.costUsd;
      }

      chunks.push({
        chunk: chunkGraph.chunk,
        dependsOn,
        dispatch: chunkGraph.dispatch ?? null,
        events,
      });

      if (chunkGraph.dispatch?.escalated != null && chunkGraph.dispatch.id) {
        escalations.push({
          chunkId: chunkGraph.chunk.id,
          dispatchId: chunkGraph.dispatch.id,
          kind: chunkGraph.dispatch.escalated,
          reason: chunkGraph.dispatch.escalationReason ?? null,
        });
        featureTotalEscalations++;
      }

      sessionTotalCost += chunkCost;
    }

    sessions.push({
      session: sessionGraph.session,
      chunks,
      totalCostUsd: sessionTotalCost,
      escalations,
    });

    featureTotalCost += sessionTotalCost;
  }

  return {
    feature: graph.feature,
    sessions,
    totalCostUsd: featureTotalCost,
    totalEscalations: featureTotalEscalations,
    chiefCostNote: "dispatch-legs only",
  };
}
