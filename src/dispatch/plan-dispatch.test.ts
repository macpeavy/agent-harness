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
  it("requires owner approval — a still-'planning' feature cannot dispatch", () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    expect(() => service.dispatchReady("F1")).toThrow("not owner-approved");
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
