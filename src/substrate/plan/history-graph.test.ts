// Tests for PlanRepository.loadFeatureGraph — verifies the full object graph read:
// feature + sessions + topologically-ordered chunks + linked dispatches.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRepository, type CreateChunk } from "./index";
import { DispatchRepository } from "../dispatch";

let dir: string;
let dbPath: string;
let plan: PlanRepository;
let dispatch: DispatchRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-graph-"));
  dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
});

afterEach(() => {
  plan.close();
  dispatch.close();
  rmSync(dir, { recursive: true, force: true });
});

function chunk(id: string, sessionId: string, over: Partial<CreateChunk> = {}): CreateChunk {
  return {
    id,
    sessionId,
    surface: `src/${id}.ts`,
    intent: `do ${id}`,
    contract: `export function ${id}(): void`,
    acceptance: `${id}.test.ts passes`,
    ...over,
  };
}

describe("loadFeatureGraph", () => {
  it("returns null for an unknown feature id", () => {
    expect(plan.loadFeatureGraph("does-not-exist")).toBeNull();
  });

  it("returns feature + sessions + chunks in topological order (precursor before dependent)", () => {
    plan.createMetaDecomposition({
      feature: { id: "F1", title: "Feature one", description: "the intent" },
      sessions: [{ id: "S1" }, { id: "S2" }],
    });
    // S1: a → b (b depends on a)
    plan.addChunkDag("S1", [chunk("a", "S1"), chunk("b", "S1")], [{ from: "a", to: "b" }]);
    // S2: c → d (d depends on c)
    plan.addChunkDag("S2", [chunk("c", "S2"), chunk("d", "S2")], [{ from: "c", to: "d" }]);

    const graph = plan.loadFeatureGraph("F1");
    expect(graph).not.toBeNull();
    expect(graph!.feature.id).toBe("F1");
    expect(graph!.sessions).toHaveLength(2);

    const sg1 = graph!.sessions[0]!;
    const sg2 = graph!.sessions[1]!;
    expect(sg1.session.id).toBe("S1");
    expect(sg2.session.id).toBe("S2");

    // S1: a must come before b
    const s1Ids = sg1.chunks.map((cg) => cg.chunk.id);
    expect(s1Ids).toEqual(["a", "b"]);

    // S2: c must come before d
    const s2Ids = sg2.chunks.map((cg) => cg.chunk.id);
    expect(s2Ids).toEqual(["c", "d"]);
  });

  it("populates linked dispatches for chunks that have been dispatched", () => {
    plan.createMetaDecomposition({
      feature: { id: "F1", title: "Feature one", description: "the intent" },
      sessions: [{ id: "S1" }, { id: "S2" }],
    });
    plan.addChunkDag("S1", [chunk("a", "S1"), chunk("b", "S1")], [{ from: "a", to: "b" }]);
    plan.addChunkDag("S2", [chunk("c", "S2"), chunk("d", "S2")], [{ from: "c", to: "d" }]);

    // Link a dispatch to chunk "a"
    dispatch.create({ id: "disp-a", issueId: "a", title: "do a", branch: "agent/a", spec: "spec-a" });
    plan.linkDispatch("a", "disp-a");

    // Link a dispatch to chunk "c"
    dispatch.create({ id: "disp-c", issueId: "c", title: "do c", branch: "agent/c", spec: "spec-c" });
    plan.linkDispatch("c", "disp-c");

    const graph = plan.loadFeatureGraph("F1");
    expect(graph).not.toBeNull();

    const sg1 = graph!.sessions[0]!;
    const sg2 = graph!.sessions[1]!;

    const cgA = sg1.chunks.find((cg) => cg.chunk.id === "a");
    expect(cgA?.dispatch?.id).toBe("disp-a");

    const cgC = sg2.chunks.find((cg) => cg.chunk.id === "c");
    expect(cgC?.dispatch?.id).toBe("disp-c");
  });

  it("sets dispatch to null for a chunk that has no linked dispatch", () => {
    plan.createMetaDecomposition({
      feature: { id: "F1", title: "Feature one", description: "the intent" },
      sessions: [{ id: "S1" }, { id: "S2" }],
    });
    plan.addChunkDag("S1", [chunk("a", "S1"), chunk("b", "S1")], [{ from: "a", to: "b" }]);
    plan.addChunkDag("S2", [chunk("c", "S2"), chunk("d", "S2")], [{ from: "c", to: "d" }]);

    const graph = plan.loadFeatureGraph("F1");
    expect(graph).not.toBeNull();

    for (const sg of graph!.sessions) {
      for (const cg of sg.chunks) {
        expect(cg.dispatch).toBeNull();
      }
    }
  });

  it("edges are included in each session's sub-graph", () => {
    plan.createMetaDecomposition({
      feature: { id: "F1", title: "Feature one", description: "the intent" },
      sessions: [{ id: "S1" }, { id: "S2" }],
    });
    plan.addChunkDag("S1", [chunk("a", "S1"), chunk("b", "S1")], [{ from: "a", to: "b" }]);
    plan.addChunkDag("S2", [chunk("c", "S2"), chunk("d", "S2")], [{ from: "c", to: "d" }]);

    const graph = plan.loadFeatureGraph("F1");
    expect(graph).not.toBeNull();

    const sg1 = graph!.sessions[0]!;
    const sg2 = graph!.sessions[1]!;
    expect(sg1.edges).toHaveLength(1);
    expect(sg1.edges[0]!.fromChunkId).toBe("a");
    expect(sg1.edges[0]!.toChunkId).toBe("b");

    expect(sg2.edges).toHaveLength(1);
    expect(sg2.edges[0]!.fromChunkId).toBe("c");
    expect(sg2.edges[0]!.toChunkId).toBe("d");
  });
});
