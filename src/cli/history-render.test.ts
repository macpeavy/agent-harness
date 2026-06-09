import { describe, expect, it } from "bun:test";
import { renderHistory } from "./history-render";
import type { FeatureHistory, SessionHistory, ChunkHistory, DispatchEvent } from "./history-assemble";
import type { Feature, Session, Chunk } from "../substrate/plan";

function makeFeature(id: string, state: string = "done"): Feature {
  return {
    id,
    title: "test feature",
    description: "test",
    state: state as any,
    budgetUsd: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeSession(id: string, featureId: string, state: string = "done"): Session {
  return {
    id,
    featureId,
    branch: "session-main",
    prNumber: 42,
    prUrl: "https://github.com/test/pr/42",
    locEstimate: 800,
    state: state as any,
    lastError: null,
    budgetExceededUsd: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeChunk(id: string, sessionId: string, state: string = "done"): Chunk {
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
    state: state as any,
    dispatchId: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeEvent(
  kind: string,
  timestampMs: number,
  costUsd: number = 0,
  escalationKind: string | null = null,
  escalationReason: string | null = null
): DispatchEvent {
  return {
    kind: kind as any,
    timestampMs,
    costUsd,
    escalationKind,
    escalationReason,
  };
}

describe("renderHistory", () => {
  it("produces header and rollup for empty feature", () => {
    const history: FeatureHistory = {
      feature: makeFeature("feat-1", "done"),
      sessions: [],
      totalCostUsd: 0,
      totalEscalations: 0,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("[done] feat-1 — \"test feature\"");
    expect(output).toContain("sessions: 0  chunks: 0");
    expect(output).toContain("escalations: 0");
  });

  it("produces escalated chunk in ESCALATIONS section", () => {
    const chunk: ChunkHistory = {
      chunk: makeChunk("chunk-1", "session-1", "escalated"),
      dependsOn: [],
      dispatch: null,
      events: [makeEvent("build", 1000, 0.1), makeEvent("escalated", 2000, 0, "re-decompose", "too complex")],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1"),
      chunks: [chunk],
      totalCostUsd: 0.1,
      escalations: [
        {
          chunkId: "chunk-1",
          dispatchId: "dispatch-1",
          kind: "re-decompose",
          reason: "too complex",
        },
      ],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-1", "done"),
      sessions: [session],
      totalCostUsd: 0.1,
      totalEscalations: 1,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("ESCALATIONS (1)");
    expect(output).toContain("chunk-1");
    expect(output).toContain("dispatch dispatch-1");
    expect(output).toContain("re-decompose");
    expect(output).toContain("too complex");
  });

  it("produces done event line", () => {
    const chunk: ChunkHistory = {
      chunk: makeChunk("chunk-1", "session-1"),
      dependsOn: [],
      dispatch: null,
      events: [makeEvent("build", 1000, 0.1), makeEvent("done", 2000, 0)],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1"),
      chunks: [chunk],
      totalCostUsd: 0.1,
      escalations: [],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-1"),
      sessions: [session],
      totalCostUsd: 0.1,
      totalEscalations: 0,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("done");
  });

  it("ensures no line exceeds 100 chars", () => {
    const longChunkId = "x".repeat(80);
    const longSurfaceName = "src/".padEnd(100, "y") + ".ts";
    const chunk: ChunkHistory = {
      chunk: {
        ...makeChunk(longChunkId, "session-1"),
        surface: longSurfaceName,
      },
      dependsOn: [longChunkId, longChunkId],
      dispatch: null,
      events: [
        makeEvent("build", 1000, 0.12345),
        makeEvent("escalated", 2000, 0, "re-decompose", "this is a very long reason that might exceed limits"),
      ],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1"),
      chunks: [chunk],
      totalCostUsd: 0.12345,
      escalations: [
        {
          chunkId: longChunkId,
          dispatchId: "dispatch-" + "x".repeat(80),
          kind: "re-decompose",
          reason: "this is a very long reason that might exceed limits",
        },
      ],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-very-" + "x".repeat(80), "done"),
      sessions: [session],
      totalCostUsd: 0.12345,
      totalEscalations: 1,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    const lines = output.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it("includes COST ROLLUP section", () => {
    const chunk: ChunkHistory = {
      chunk: makeChunk("chunk-1", "session-1"),
      dependsOn: [],
      dispatch: null,
      events: [makeEvent("build", 1000, 0.15)],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1"),
      chunks: [chunk],
      totalCostUsd: 0.15,
      escalations: [],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-1"),
      sessions: [session],
      totalCostUsd: 0.15,
      totalEscalations: 0,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("COST ROLLUP");
    expect(output).toContain("session-1: $0.1500");
    expect(output).toContain("TOTAL: $0.1500");
  });

  it("includes session info with PR and LOC", () => {
    const chunk: ChunkHistory = {
      chunk: makeChunk("chunk-1", "session-1"),
      dependsOn: [],
      dispatch: null,
      events: [],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1", "review"),
      chunks: [chunk],
      totalCostUsd: 0,
      escalations: [],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-1", "building"),
      sessions: [session],
      totalCostUsd: 0,
      totalEscalations: 0,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("session session-1 [review]");
    expect(output).toContain("PR #42");
    expect(output).toContain("~800 LOC");
  });

  it("includes chunk dependencies", () => {
    const chunk: ChunkHistory = {
      chunk: makeChunk("chunk-2", "session-1"),
      dependsOn: ["chunk-1", "chunk-0"],
      dispatch: null,
      events: [],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1"),
      chunks: [chunk],
      totalCostUsd: 0,
      escalations: [],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-1"),
      sessions: [session],
      totalCostUsd: 0,
      totalEscalations: 0,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("depends on: chunk-1, chunk-0");
  });

  it("formats cost events with USD notation", () => {
    const chunk: ChunkHistory = {
      chunk: makeChunk("chunk-1", "session-1"),
      dependsOn: [],
      dispatch: null,
      events: [
        makeEvent("build", 1000, 0.1234),
        makeEvent("review", 2000, 0.0567),
        makeEvent("amend", 3000, 0.0089),
      ],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1"),
      chunks: [chunk],
      totalCostUsd: 0.189,
      escalations: [],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-1"),
      sessions: [session],
      totalCostUsd: 0.189,
      totalEscalations: 0,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("$0.1234");
    expect(output).toContain("$0.0567");
    expect(output).toContain("$0.0089");
  });

  it("handles multiple sessions", () => {
    const chunk1: ChunkHistory = {
      chunk: makeChunk("chunk-1", "session-1"),
      dependsOn: [],
      dispatch: null,
      events: [makeEvent("build", 1000, 0.1)],
    };
    const session1: SessionHistory = {
      session: makeSession("session-1", "feat-1", "done"),
      chunks: [chunk1],
      totalCostUsd: 0.1,
      escalations: [],
    };

    const chunk2: ChunkHistory = {
      chunk: makeChunk("chunk-2", "session-2"),
      dependsOn: [],
      dispatch: null,
      events: [makeEvent("build", 2000, 0.2)],
    };
    const session2: SessionHistory = {
      session: makeSession("session-2", "feat-1", "done"),
      chunks: [chunk2],
      totalCostUsd: 0.2,
      escalations: [],
    };

    const history: FeatureHistory = {
      feature: makeFeature("feat-1", "done"),
      sessions: [session1, session2],
      totalCostUsd: 0.3,
      totalEscalations: 0,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("sessions: 2  chunks: 2");
    expect(output).toContain("session-1");
    expect(output).toContain("session-2");
    expect(output).toContain("TOTAL: $0.3000");
  });

  it("handles escalation with null reason", () => {
    const chunk: ChunkHistory = {
      chunk: makeChunk("chunk-1", "session-1", "escalated"),
      dependsOn: [],
      dispatch: null,
      events: [makeEvent("build", 1000, 0.1), makeEvent("escalated", 2000, 0, "tier-promote", null)],
    };
    const session: SessionHistory = {
      session: makeSession("session-1", "feat-1"),
      chunks: [chunk],
      totalCostUsd: 0.1,
      escalations: [
        {
          chunkId: "chunk-1",
          dispatchId: "dispatch-1",
          kind: "tier-promote",
          reason: null,
        },
      ],
    };
    const history: FeatureHistory = {
      feature: makeFeature("feat-1"),
      sessions: [session],
      totalCostUsd: 0.1,
      totalEscalations: 1,
      chiefCostNote: "dispatch-legs only",
    };
    const output = renderHistory(history);
    expect(output).toContain("tier-promote: —");
  });
});
