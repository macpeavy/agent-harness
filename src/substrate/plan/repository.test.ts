import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRepository, type Chunk, type CreateChunk } from "./index";
import { DispatchRepository } from "../dispatch";

let dir: string;
let dbPath: string;
let plan: PlanRepository;
// The dispatch repo stands in for the service layer here — the test binds the two
// independent repos (the plan repo never imports it), over the one shared substrate db.
let dispatch: DispatchRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-plan-"));
  dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
});

afterEach(() => {
  plan.close();
  dispatch.close();
  rmSync(dir, { recursive: true, force: true });
});

const FEATURE = { id: "F1", title: "A feature", description: "the owner's intent" };

function chunk(id: string, over: Partial<CreateChunk> = {}): CreateChunk {
  return {
    id,
    featureId: "F1",
    surface: `src/${id}.ts`,
    intent: `do ${id}`,
    contract: `export function ${id}(): void`,
    acceptance: `${id}.test.ts passes`,
    ...over,
  };
}

// What the service assembles into a dispatch's build-spec from a chunk's spec fields.
function specFromChunk(c: Chunk): string {
  return `[${c.surface}] ${c.intent}\n\n## Contract\n${c.contract}\n\n## Acceptance\n${c.acceptance}`;
}

describe("create: feature + chunks + edges", () => {
  it("creates a feature in 'planning', chunks in 'planned', and an edge", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("F1", "a", "b");

    expect(plan.getFeature("F1")?.state).toBe("planning");
    expect(plan.getChunk("a")?.state).toBe("planned");
    expect(plan.getChunk("a")?.contract).toBe("export function a(): void");
    expect(plan.listChunks("F1").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("enforces the feature FK — a chunk for a missing feature is rejected", () => {
    expect(() => plan.addChunk(chunk("orphan", { featureId: "nope" }))).toThrow();
  });

  it("walks a feature through its state machine and rejects an illegal jump", () => {
    plan.createFeature(FEATURE);
    plan.transitionFeature("F1", "ready");
    expect(plan.getFeature("F1")?.state).toBe("ready");
    expect(() => plan.transitionFeature("F1", "done")).toThrow("illegal feature transition ready → done");
  });
});

describe("readyChunks", () => {
  it("returns roots first, respects deps, and excludes dispatched chunks", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a")); // root
    plan.addChunk(chunk("b"));
    plan.addChunk(chunk("c"));
    plan.addEdge("F1", "a", "b"); // b depends on a
    plan.addEdge("F1", "a", "c"); // c depends on a

    // Only the root is ready while a is undone.
    expect(plan.readyChunks("F1").map((c) => c.id)).toEqual(["a"]);

    // a reaches done → its dependents unlock.
    plan.transition("a", "dispatched");
    plan.transition("a", "done");
    expect(plan.readyChunks("F1").map((c) => c.id)).toEqual(["b", "c"]);

    // Dispatching b excludes it (no longer 'planned'); c stays ready.
    plan.transition("b", "dispatched");
    expect(plan.readyChunks("F1").map((c) => c.id)).toEqual(["c"]);
  });
});

describe("the chunk DAG", () => {
  it("rejects a self-edge", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    expect(() => plan.addEdge("F1", "a", "a")).toThrow("self-edge");
  });

  it("rejects an edge that would create a cycle", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addChunk(chunk("c"));
    plan.addEdge("F1", "a", "b");
    plan.addEdge("F1", "b", "c"); // a → b → c

    expect(() => plan.addEdge("F1", "c", "a")).toThrow("cycle");
  });
});

describe("chunk transitions", () => {
  it("rejects an illegal transition", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    expect(() => plan.transition("a", "done")).toThrow("illegal chunk transition planned → done");
  });
});

describe("the dispatch seam (service binds the two repos)", () => {
  it("links a chunk to a dispatch built from its spec, and marks it dispatched", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    const c = plan.getChunk("a")!;

    // The service materialises the chunk as a dispatch, populating the build-spec from
    // the chunk's spec fields, then asks the plan to record the link.
    dispatch.create({ id: "disp-a", issueId: "a", title: c.intent, branch: "agent/a", spec: specFromChunk(c) });
    plan.linkDispatch("a", "disp-a");

    expect(plan.getChunk("a")?.state).toBe("dispatched");
    expect(plan.getChunk("a")?.dispatchId).toBe("disp-a");
    expect(dispatch.get("disp-a")?.spec).toContain("export function a(): void"); // populated from the chunk
  });

  it("enforces the cross-context FK — linking to a missing dispatch is rejected", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    expect(() => plan.linkDispatch("a", "ghost-dispatch")).toThrow();
    expect(plan.getChunk("a")?.state).toBe("planned"); // rolled back
  });

  it("flows a dispatch outcome back onto the chunk", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    const ca = plan.getChunk("a")!;
    const cb = plan.getChunk("b")!;

    dispatch.create({ id: "disp-a", issueId: "a", title: ca.intent, branch: "agent/a", spec: specFromChunk(ca) });
    dispatch.create({ id: "disp-b", issueId: "b", title: cb.intent, branch: "agent/b", spec: specFromChunk(cb) });
    plan.linkDispatch("a", "disp-a");
    plan.linkDispatch("b", "disp-b");

    // The service drives the dispatches to terminal, reads their state, and flows it back.
    dispatch.transition("disp-a", "building");
    dispatch.transition("disp-a", "review");
    dispatch.transition("disp-a", "done");
    plan.recordOutcome("a", dispatch.get("disp-a")!.state as "done");
    expect(plan.getChunk("a")?.state).toBe("done");

    dispatch.transition("disp-b", "building");
    dispatch.escalate("disp-b", "re-decompose");
    plan.recordOutcome("b", "escalated");
    expect(plan.getChunk("b")?.state).toBe("escalated");
  });
});

describe("createDecomposition (transactional batch)", () => {
  it("writes the feature, chunks, and edges in one shot", () => {
    plan.createDecomposition({
      feature: FEATURE,
      chunks: [chunk("a"), chunk("b")],
      edges: [{ from: "a", to: "b" }],
    });

    expect(plan.getFeature("F1")?.state).toBe("planning");
    expect(plan.listChunks("F1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.getChunk("a")?.contract).toBe("export function a(): void");
    // The edge landed: b depends on a, so only a is ready.
    expect(plan.readyChunks("F1").map((c) => c.id)).toEqual(["a"]);
  });

  it("rolls back the whole batch on a failure mid-write (atomic)", () => {
    // Two chunks share an id → the second insert hits the PK and the transaction aborts.
    expect(() =>
      plan.createDecomposition({ feature: FEATURE, chunks: [chunk("a"), chunk("a")], edges: [] }),
    ).toThrow();
    // Nothing landed — not even the feature inserted before the failing chunk.
    expect(plan.getFeature("F1")).toBeNull();
    expect(plan.listChunks("F1")).toEqual([]);
  });
});

describe("setTierHint", () => {
  it("updates a chunk's tier hint", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    expect(plan.getChunk("a")?.tierHint).toBe("cheap"); // default
    plan.setTierHint("a", "strong");
    expect(plan.getChunk("a")?.tierHint).toBe("strong");
  });

  it("throws for a missing chunk", () => {
    expect(() => plan.setTierHint("ghost", "strong")).toThrow("no chunk ghost");
  });
});

describe("listEdges", () => {
  it("returns a feature's edges as from→to pairs", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("F1", "a", "b");
    expect(plan.listEdges("F1")).toEqual([{ from: "a", to: "b" }]);
  });
});

describe("redecompose", () => {
  it("retires the escalated chunk (→ superseded), drops its edges, and adds the replacements", () => {
    // a → b; a escalates and is split into a1, a2 (a2 reconnects to b).
    plan.createDecomposition({ feature: FEATURE, chunks: [chunk("a"), chunk("b")], edges: [{ from: "a", to: "b" }] });
    plan.transitionFeature("F1", "ready");
    plan.transition("a", "dispatched");
    plan.transition("a", "escalated");

    plan.redecompose(
      "a",
      [chunk("a1"), chunk("a2")],
      [{ from: "a1", to: "a2" }, { from: "a2", to: "b" }],
    );

    expect(plan.getChunk("a")?.state).toBe("superseded");
    expect(plan.listChunks("F1").map((c) => c.id)).toEqual(["a", "b", "a1", "a2"]);
    // The retired chunk's edge a→b is gone; the rewired graph is a1→a2→b.
    expect(plan.listEdges("F1").sort((x, y) => x.from.localeCompare(y.from))).toEqual([
      { from: "a1", to: "a2" },
      { from: "a2", to: "b" },
    ]);
    // b now depends on a2 (not the retired a); a1 is the only root ready.
    expect(plan.readyChunks("F1").map((c) => c.id)).toEqual(["a1"]);
  });

  it("rejects re-decomposing a chunk that isn't escalated", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    expect(() => plan.redecompose("a", [chunk("a1")], [])).toThrow("illegal chunk transition planned → superseded");
  });
});
