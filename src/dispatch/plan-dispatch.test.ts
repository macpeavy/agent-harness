import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanDispatchService, outcomeFor, specFromChunk } from "./plan-dispatch";
import { PlanRepository, type Chunk, type CreateChunk } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";

// The service binds the two independent repositories over the one shared substrate db
// (the repos never import each other — ADR 0017). The test opens both on the same file.
let dir: string;
let plan: PlanRepository;
let dispatch: DispatchRepository;
let service: PlanDispatchService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-plandisp-"));
  const dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
  service = new PlanDispatchService(plan, dispatch);
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

// Drive a dispatch to a terminal/parked state the way the daemon would, so the service
// can reap its outcome. The service never drives the build loop itself.
function driveTo(dispatchId: string, end: "done" | "escalated" | "failed"): void {
  if (end === "failed") {
    dispatch.transition(dispatchId, "building");
    dispatch.transition(dispatchId, "failed");
    return;
  }
  dispatch.transition(dispatchId, "building");
  if (end === "escalated") {
    dispatch.escalate(dispatchId, "re-decompose");
    return;
  }
  dispatch.transition(dispatchId, "review");
  dispatch.transition(dispatchId, "done");
}

describe("specFromChunk", () => {
  it("assembles the required spec fields, and folds in the optional ones when present", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a", { dataShapes: "X = { n: number }", preResolved: "use Drizzle", outOfScope: "no UI" }));
    const spec = specFromChunk(plan.getChunk("a") as Chunk);

    expect(spec).toContain("[src/a.ts] do a");
    expect(spec).toContain("## Contract\nexport function a(): void");
    expect(spec).toContain("## Acceptance\na.test.ts passes");
    expect(spec).toContain("## Data shapes\nX = { n: number }");
    expect(spec).toContain("## Pre-resolved decisions\nuse Drizzle");
    expect(spec).toContain("## Out of scope\nno UI");
  });

  it("omits the optional sections when the chunk has none", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    const spec = specFromChunk(plan.getChunk("a") as Chunk);

    expect(spec).not.toContain("## Data shapes");
    expect(spec).not.toContain("## Pre-resolved");
    expect(spec).not.toContain("## Out of scope");
  });
});

describe("outcomeFor", () => {
  it("maps terminal/parked dispatch states to chunk outcomes and in-flight ones to null", () => {
    expect(outcomeFor("done")).toBe("done");
    expect(outcomeFor("escalated")).toBe("escalated");
    expect(outcomeFor("failed")).toBe("failed");
    expect(outcomeFor("queued")).toBeNull();
    expect(outcomeFor("building")).toBeNull();
    expect(outcomeFor("review")).toBeNull();
    expect(outcomeFor("amending")).toBeNull();
  });
});

describe("dispatchReady", () => {
  it("approves a still-'planning' feature in-line (dispatch IS the go) and materialises it", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));

    const made = service.dispatchReady("F1"); // no prior transitionFeature — dispatch approves

    expect(made).toEqual([{ chunkId: "a", dispatchId: "a" }]);
    expect(plan.getChunk("a")?.state).toBe("dispatched");
    // planning → ready → building, folded into the one dispatch call.
    expect(plan.getFeature("F1")?.state).toBe("building");
  });

  it("materialises ready chunks: a dispatch per chunk carrying its curation, linked back", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.transitionFeature("F1", "ready");

    const made = service.dispatchReady("F1");

    expect(made).toEqual([{ chunkId: "a", dispatchId: "a" }]);
    // The chunk is linked and dispatched.
    expect(plan.getChunk("a")?.state).toBe("dispatched");
    expect(plan.getChunk("a")?.dispatchId).toBe("a");
    // The dispatch carries the assembled spec AND the structured curation (the dormant
    // context-pack curation, now live — ADR 0018/0019).
    const d = dispatch.get("a");
    expect(d?.spec).toContain("export function a(): void");
    expect(d?.surface).toBe("src/a.ts");
    // First dispatch of an approved feature moves it into 'building'.
    expect(plan.getFeature("F1")?.state).toBe("building");
  });

  it("respects the DAG — only dependency-satisfied chunks dispatch", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("F1", "a", "b"); // b depends on a
    plan.transitionFeature("F1", "ready");

    const made = service.dispatchReady("F1");

    expect(made.map((m) => m.chunkId)).toEqual(["a"]); // b is gated
    expect(plan.getChunk("b")?.state).toBe("planned");
  });

  it("dispatches nothing (and is a no-op) when no chunk is ready", () => {
    plan.createFeature(FEATURE);
    plan.transitionFeature("F1", "ready");
    expect(service.dispatchReady("F1")).toEqual([]);
    expect(plan.getFeature("F1")?.state).toBe("ready"); // unmoved
  });

  it("throws for an unknown feature", () => {
    expect(() => service.dispatchReady("nope")).toThrow("no feature");
  });
});

describe("recordOutcomes", () => {
  it("flows each terminal dispatch outcome back, and leaves in-flight chunks alone", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addChunk(chunk("c"));
    plan.transitionFeature("F1", "ready");
    service.dispatchReady("F1");

    driveTo("a", "done");
    driveTo("b", "escalated");
    // c left in flight (queued)

    const flowed = service.recordOutcomes("F1");

    expect(flowed).toContainEqual({ chunkId: "a", outcome: "done" });
    expect(flowed).toContainEqual({ chunkId: "b", outcome: "escalated" });
    expect(flowed.map((f) => f.chunkId)).not.toContain("c");
    expect(plan.getChunk("a")?.state).toBe("done");
    expect(plan.getChunk("b")?.state).toBe("escalated");
    expect(plan.getChunk("c")?.state).toBe("dispatched"); // unchanged
    // Not every chunk is done, so the feature stays building.
    expect(plan.getFeature("F1")?.state).toBe("building");
  });

  it("moves the feature to 'done' once every chunk is done", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.transitionFeature("F1", "ready");
    service.dispatchReady("F1");

    driveTo("a", "done");
    driveTo("b", "done");
    service.recordOutcomes("F1");

    expect(plan.getChunk("a")?.state).toBe("done");
    expect(plan.getChunk("b")?.state).toBe("done");
    expect(plan.getFeature("F1")?.state).toBe("done");
  });

  it("flows a failed dispatch back as a failed chunk", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.transitionFeature("F1", "ready");
    service.dispatchReady("F1");

    driveTo("a", "failed");
    service.recordOutcomes("F1");

    expect(plan.getChunk("a")?.state).toBe("failed");
    expect(plan.getFeature("F1")?.state).toBe("building"); // not all done
  });
});

describe("re-dispatch after escalation", () => {
  it("refuses to re-dispatch a chunk whose dispatch id is taken (escalation loop is a later slice)", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.transitionFeature("F1", "ready");
    service.dispatchReady("F1");

    // The dispatch escalates; the chief sends the chunk back to 'planned' to re-decompose.
    driveTo("a", "escalated");
    service.recordOutcomes("F1");
    expect(plan.getChunk("a")?.state).toBe("escalated");
    plan.transition("a", "planned");

    // The dispatchId == chunkId invariant means the id is taken — a re-build's branch/PR
    // strategy is unresolved, so this is an explicit error rather than a branch mismatch.
    expect(() => service.dispatchReady("F1")).toThrow("re-dispatch");
  });
});

describe("status", () => {
  it("throws for an unknown feature", () => {
    expect(() => service.status("nope")).toThrow("no feature");
  });

  it("digests a fresh feature: chunks 'planned', no dispatches, zeroed readout", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));

    const s = service.status("F1");

    expect(s.feature).toEqual({ id: "F1", title: "A feature", state: "planning" });
    expect(s.chunks).toHaveLength(2);
    expect(s.chunks[0]).toMatchObject({ id: "a", surface: "src/a.ts", state: "planned", dispatchId: null, dispatchState: null });
    expect(s.escalations).toEqual([]);
    expect(s.readout.total).toBe(0);
  });

  it("joins each chunk to its dispatch state and computes the readout over the feature's dispatches", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addChunk(chunk("c"));
    plan.transitionFeature("F1", "ready");
    service.dispatchReady("F1");

    driveTo("a", "done");
    dispatch.transition("b", "building"); // b in flight
    // c left queued

    const s = service.status("F1");

    expect(s.feature.state).toBe("building");
    const byId = Object.fromEntries(s.chunks.map((c) => [c.id, c]));
    expect(byId.a).toMatchObject({ state: "dispatched", dispatchState: "done" }); // chunk state not yet reaped
    expect(byId.b?.dispatchState).toBe("building");
    expect(byId.c?.dispatchState).toBe("queued");
    // Readout is over the 3 dispatches: 1 done, 2 in-flight.
    expect(s.readout.total).toBe(3);
    expect(s.readout.reachedReady).toBe(1);
    expect(s.readout.inFlight).toBe(2);
  });

  it("surfaces parked escalations with their kind for routing", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.transitionFeature("F1", "ready");
    service.dispatchReady("F1");

    driveTo("a", "escalated"); // escalate("re-decompose") under the hood

    const s = service.status("F1");

    expect(s.escalations).toEqual([{ chunkId: "a", dispatchId: "a", kind: "re-decompose" }]);
    expect(s.chunks[0]?.dispatchState).toBe("escalated");
  });
});

describe("decompose", () => {
  it("writes a feature's chunk-DAG to the plan and returns a summary", () => {
    const result = service.decompose({
      feature: FEATURE,
      chunks: [chunk("a"), chunk("b")],
      edges: [{ from: "a", to: "b" }],
    });

    expect(result).toEqual({ featureId: "F1", chunkIds: ["a", "b"], edgeCount: 1 });
    expect(service.status("F1").feature.state).toBe("planning"); // not yet approved
    expect(plan.listChunks("F1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.readyChunks("F1").map((c) => c.id)).toEqual(["a"]); // edge a→b in effect
  });

  it("rejects a cyclic DAG before writing anything", () => {
    expect(() =>
      service.decompose({
        feature: FEATURE,
        chunks: [chunk("a"), chunk("b")],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
      }),
    ).toThrow("invalid chunk-DAG");
    expect(plan.getFeature("F1")).toBeNull(); // nothing landed
  });

  it("rejects an edge to an unknown chunk", () => {
    expect(() =>
      service.decompose({ feature: FEATURE, chunks: [chunk("a")], edges: [{ from: "a", to: "ghost" }] }),
    ).toThrow("invalid chunk-DAG");
  });
});
