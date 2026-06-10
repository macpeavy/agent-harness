import { describe, expect, it } from "bun:test";
import { assembleHistory, type FeatureHistory } from "./history-assemble";
import type { Chunk, Edge, Feature, FeatureGraph, Session } from "../substrate/plan";
import type { Dispatch } from "../substrate/dispatch";

function makeFeature(id: string): Feature {
  return {
    id,
    title: "test feature",
    description: "test",
    state: "ready",
    budgetUsd: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeSession(id: string, featureId: string): Session {
  return {
    id,
    featureId,
    branch: "session-main",
    prNumber: 1,
    prUrl: "https://github.com/test/pr/1",
    locEstimate: 100,
    state: "done",
    lastError: null,
    budgetExceededUsd: null,
    signaledAt: null,
    ciFailedSha: null,
    ciFailedChecks: null,
    ciSignaledSha: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeChunk(id: string, sessionId: string): Chunk {
  return {
    id,
    sessionId,
    surface: "src/test.ts",
    intent: "test intent",
    contract: "export function test(): void",
    acceptance: "test passes",
    dataShapes: null,
    preResolved: null,
    outOfScope: null,
    tierHint: "cheap",
    state: "done",
    dispatchId: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeDispatch(
  id: string,
  chunkId: string,
  options?: { buildCostUsd?: number; reviewCostUsd?: number; amendCostUsd?: number; escalated?: string; escalationReason?: string; state?: string }
): Dispatch {
  return {
    id,
    issueId: "test-issue",
    title: "test build",
    branch: "test-branch",
    spec: "test spec",
    surface: "src/test.ts",
    skills: [],
    tier: "cheap",
    sessionBranch: "session-main",
    state: (options?.state ?? "done") as any,
    pendingFindings: null,
    buildSessionId: "build-session-1",
    reviewSessionId: "review-session-1",
    prUrl: "https://github.com/test/pr/1",
    route: null,
    amendRounds: 0,
    escalated: (options?.escalated ?? null) as any,
    escalationReason: options?.escalationReason ?? null,
    buildCostUsd: options?.buildCostUsd ?? 0.1,
    reviewCostUsd: options?.reviewCostUsd ?? 0.05,
    amendCostUsd: options?.amendCostUsd ?? 0,
    createdAt: 1000,
    updatedAt: 2000,
    reapedAt: null,
  };
}

describe("assembleHistory", () => {
  it("returns totals=0 for empty feature", () => {
    const graph: FeatureGraph = {
      feature: makeFeature("feat-1"),
      sessions: [],
    };
    const result = assembleHistory(graph);
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalEscalations).toBe(0);
    expect(result.sessions.length).toBe(0);
  });

   it("produces done event from done dispatch", () => {
     const session = makeSession("session-1", "feat-1");
     const chunk = makeChunk("chunk-1", "session-1");
     const dispatch = makeDispatch("dispatch-1", "chunk-1");
     chunk.dispatchId = "dispatch-1";

     const graph: FeatureGraph = {
       feature: makeFeature("feat-1"),
       sessions: [
         {
           session,
           chunks: [{ chunk, dispatch }],
           edges: [],
         },
       ],
     };

     const result = assembleHistory(graph);
     expect(result.sessions.length).toBe(1);
     expect(result.sessions[0]!.chunks.length).toBe(1);
     const events = result.sessions[0]!.chunks[0]!.events;
     expect(events.some((e) => e.kind === "done")).toBe(true);
   });

   it("produces escalated event from escalated dispatch", () => {
     const session = makeSession("session-1", "feat-1");
     const chunk = makeChunk("chunk-1", "session-1");
     const dispatch = makeDispatch("dispatch-1", "chunk-1", {
       escalated: "re-decompose",
       escalationReason: "too complex",
       state: "escalated",
     });
     chunk.dispatchId = "dispatch-1";

     const graph: FeatureGraph = {
       feature: makeFeature("feat-1"),
       sessions: [
         {
           session,
           chunks: [{ chunk, dispatch }],
           edges: [],
         },
       ],
     };

     const result = assembleHistory(graph);
     const events = result.sessions[0]!.chunks[0]!.events;
     const escalatedEvent = events.find((e) => e.kind === "escalated");
     expect(escalatedEvent).toBeDefined();
     expect(escalatedEvent?.escalationKind).toBe("re-decompose");
     expect(escalatedEvent?.escalationReason).toBe("too complex");
   });

   it("sums totalCostUsd correctly", () => {
     const session = makeSession("session-1", "feat-1");
     const chunk1 = makeChunk("chunk-1", "session-1");
     const chunk2 = makeChunk("chunk-2", "session-1");
     const dispatch1 = makeDispatch("dispatch-1", "chunk-1", { buildCostUsd: 0.1, reviewCostUsd: 0.05 });
     const dispatch2 = makeDispatch("dispatch-2", "chunk-2", { buildCostUsd: 0.2, reviewCostUsd: 0.1 });
     chunk1.dispatchId = "dispatch-1";
     chunk2.dispatchId = "dispatch-2";

     const graph: FeatureGraph = {
       feature: makeFeature("feat-1"),
       sessions: [
         {
           session,
           chunks: [
             { chunk: chunk1, dispatch: dispatch1 },
             { chunk: chunk2, dispatch: dispatch2 },
           ],
           edges: [],
         },
       ],
     };

     const result = assembleHistory(graph);
     expect(result.totalCostUsd).toBeCloseTo(0.45, 5);
     expect(result.sessions[0]!.totalCostUsd).toBeCloseTo(0.45, 5);
   });

   it("sets dependsOn from edges", () => {
     const session = makeSession("session-1", "feat-1");
     const chunk1 = makeChunk("chunk-1", "session-1");
     const chunk2 = makeChunk("chunk-2", "session-1");
     const edge: Edge = {
       id: "edge-1",
       sessionId: "session-1",
       fromChunkId: "chunk-1",
       toChunkId: "chunk-2",
       createdAt: 1000,
     };

     const graph: FeatureGraph = {
       feature: makeFeature("feat-1"),
       sessions: [
         {
           session,
           chunks: [
             { chunk: chunk1, dispatch: null },
             { chunk: chunk2, dispatch: null },
           ],
           edges: [edge],
         },
       ],
     };

     const result = assembleHistory(graph);
     const chunk2History = result.sessions[0]!.chunks[1]!;
     expect(chunk2History.dependsOn).toEqual(["chunk-1"]);
   });

   it("tracks escalations in session and feature totals", () => {
     const session = makeSession("session-1", "feat-1");
     const chunk1 = makeChunk("chunk-1", "session-1");
     const chunk2 = makeChunk("chunk-2", "session-1");
     const dispatch1 = makeDispatch("dispatch-1", "chunk-1", {
       escalated: "tier-promote",
       escalationReason: "too hard",
       state: "escalated",
     });
     const dispatch2 = makeDispatch("dispatch-2", "chunk-2", { state: "done" });
     chunk1.dispatchId = "dispatch-1";
     chunk2.dispatchId = "dispatch-2";

     const graph: FeatureGraph = {
       feature: makeFeature("feat-1"),
       sessions: [
         {
           session,
           chunks: [
             { chunk: chunk1, dispatch: dispatch1 },
             { chunk: chunk2, dispatch: dispatch2 },
           ],
           edges: [],
         },
       ],
     };

     const result = assembleHistory(graph);
     expect(result.totalEscalations).toBe(1);
     expect(result.sessions[0]!.escalations.length).toBe(1);
     expect(result.sessions[0]!.escalations[0]!.kind).toBe("tier-promote");
     expect(result.sessions[0]!.escalations[0]!.reason).toBe("too hard");
   });

   it("handles dispatch with null costs as zero", () => {
     const session = makeSession("session-1", "feat-1");
     const chunk = makeChunk("chunk-1", "session-1");
     const dispatch = makeDispatch("dispatch-1", "chunk-1", {
       buildCostUsd: 0.1,
       reviewCostUsd: 0,
       amendCostUsd: 0,
     });
     chunk.dispatchId = "dispatch-1";

     const graph: FeatureGraph = {
       feature: makeFeature("feat-1"),
       sessions: [
         {
           session,
           chunks: [{ chunk, dispatch }],
           edges: [],
         },
       ],
     };

     const result = assembleHistory(graph);
     expect(result.totalCostUsd).toBeCloseTo(0.1, 5);
   });

   it("handles chunk with no dispatch", () => {
     const session = makeSession("session-1", "feat-1");
     const chunk = makeChunk("chunk-1", "session-1");

     const graph: FeatureGraph = {
       feature: makeFeature("feat-1"),
       sessions: [
         {
           session,
           chunks: [{ chunk, dispatch: null }],
           edges: [],
         },
       ],
     };

     const result = assembleHistory(graph);
     expect(result.sessions[0]!.chunks[0]!.dispatch).toBeNull();
     expect(result.sessions[0]!.chunks[0]!.events.length).toBe(0);
     expect(result.totalCostUsd).toBe(0);
   });

  it("sets chiefCostNote to dispatch-legs only", () => {
    const graph: FeatureGraph = {
      feature: makeFeature("feat-1"),
      sessions: [],
    };
    const result = assembleHistory(graph);
    expect(result.chiefCostNote).toBe("dispatch-legs only");
  });
});
