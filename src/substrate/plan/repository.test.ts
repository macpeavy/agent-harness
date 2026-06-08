import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRepository, type CreateChunk } from "./index";
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

// A feature + one session, both in 'planning' — the common starting point.
function seedFeatureSession(sessionId = "S1"): void {
  plan.createFeature(FEATURE);
  plan.createSession({ id: sessionId, featureId: "F1" });
}

function chunk(id: string, over: Partial<CreateChunk> = {}): CreateChunk {
  return {
    id,
    sessionId: "S1",
    surface: `src/${id}.ts`,
    intent: `do ${id}`,
    contract: `export function ${id}(): void`,
    acceptance: `${id}.test.ts passes`,
    ...over,
  };
}

describe("sessions: create / list / get", () => {
  it("creates a session under a feature in 'planning' and reads it back", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1", locEstimate: 900 });

    const s = plan.getSession("S1");
    expect(s?.featureId).toBe("F1");
    expect(s?.state).toBe("planning");
    expect(s?.locEstimate).toBe(900);
    expect(s?.branch).toBeNull(); // populated by slice 2
    expect(plan.listSessions("F1").map((x) => x.id)).toEqual(["S1"]);
  });

  it("lists a feature's sessions oldest-first", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.createSession({ id: "S2", featureId: "F1" });
    expect(plan.listSessions("F1").map((s) => s.id)).toEqual(["S1", "S2"]);
  });

  it("enforces the feature FK — a session for a missing feature is rejected", () => {
    expect(() => plan.createSession({ id: "S1", featureId: "nope" })).toThrow();
  });
});

describe("chunks re-parented to sessions", () => {
  it("a chunk belongs to a session; listChunks is session-scoped", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.createSession({ id: "S2", featureId: "F1" });
    plan.addChunk(chunk("a", { sessionId: "S1" }));
    plan.addChunk(chunk("b", { sessionId: "S2" }));

    expect(plan.getChunk("a")?.sessionId).toBe("S1");
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a"]);
    expect(plan.listChunks("S2").map((c) => c.id)).toEqual(["b"]);
  });

  it("enforces the session FK — a chunk for a missing session is rejected", () => {
    seedFeatureSession();
    expect(() => plan.addChunk(chunk("a", { sessionId: "ghost" }))).toThrow();
  });
});

describe("per-session readyChunks", () => {
  it("scopes readiness + the DAG to a session", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.createSession({ id: "S2", featureId: "F1" });
    plan.addChunk(chunk("a", { sessionId: "S1" }));
    plan.addChunk(chunk("b", { sessionId: "S1" }));
    plan.addEdge("S1", "a", "b"); // b depends on a, within S1
    plan.addChunk(chunk("c", { sessionId: "S2" }));

    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a"]); // b gated
    expect(plan.readyChunks("S2").map((c) => c.id)).toEqual(["c"]); // independent session

    plan.transition("a", "dispatched");
    plan.transition("a", "done");
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["b"]); // a done unlocks b
  });
});

describe("session transitions", () => {
  it("walks a session through its state machine", () => {
    seedFeatureSession();
    plan.transitionSession("S1", "ready");
    plan.transitionSession("S1", "building");
    plan.transitionSession("S1", "done");
    expect(plan.getSession("S1")?.state).toBe("done");
  });

  it("rejects an illegal session transition", () => {
    seedFeatureSession();
    expect(() => plan.transitionSession("S1", "building")).toThrow(
      "illegal session transition planning → building",
    );
  });

  it("links a session to its branch + PR (slice 2 populates these)", () => {
    seedFeatureSession();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 42, prUrl: "http://pr/42" });
    const s = plan.getSession("S1");
    expect(s?.branch).toBe("session-main-S1");
    expect(s?.prNumber).toBe(42);
  });
});

describe("planning-amendable (ADR 0020)", () => {
  it("allows adding sessions/chunks/edges while the feature is in planning", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a", { sessionId: "S1" }));
    plan.addChunk(chunk("b", { sessionId: "S1" }));
    plan.addEdge("S1", "a", "b");
    plan.createSession({ id: "S2", featureId: "F1" }); // a second session, mid-planning
    expect(plan.listSessions("F1")).toHaveLength(2);
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("freezes the plan once the feature leaves planning (approved)", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a", { sessionId: "S1" }));
    plan.transitionFeature("F1", "ready"); // owner approval

    expect(() => plan.createSession({ id: "S2", featureId: "F1" })).toThrow("not amendable");
    expect(() => plan.addChunk(chunk("b", { sessionId: "S1" }))).toThrow("not amendable");
    expect(() => plan.addEdge("S1", "a", "a")).toThrow(); // (self-edge guard fires first, also fine)
  });
});

describe("createDecomposition (transactional: feature + session + DAG)", () => {
  it("writes the feature, the session, and the chunk-DAG in one shot", () => {
    plan.createDecomposition({
      feature: FEATURE,
      session: { id: "S1", locEstimate: 800 },
      chunks: [chunk("a"), chunk("b")],
      edges: [{ from: "a", to: "b" }],
    });

    expect(plan.getFeature("F1")?.state).toBe("planning");
    expect(plan.getSession("S1")?.locEstimate).toBe(800);
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a"]); // a→b edge landed
  });

  it("rolls back the whole batch on a mid-write failure (atomic)", () => {
    expect(() =>
      plan.createDecomposition({
        feature: FEATURE,
        session: { id: "S1" },
        chunks: [chunk("a"), chunk("a")], // duplicate id → PK abort
        edges: [],
      }),
    ).toThrow();
    expect(plan.getFeature("F1")).toBeNull();
    expect(plan.getSession("S1")).toBeNull();
  });
});

describe("the chunk DAG (within a session)", () => {
  it("rejects a self-edge and a cycle", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addChunk(chunk("c"));
    plan.addEdge("S1", "a", "b");
    plan.addEdge("S1", "b", "c");

    expect(() => plan.addEdge("S1", "a", "a")).toThrow("self-edge");
    expect(() => plan.addEdge("S1", "c", "a")).toThrow("cycle");
  });

  it("listEdges is session-scoped", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("S1", "a", "b");
    expect(plan.listEdges("S1")).toEqual([{ from: "a", to: "b" }]);
  });
});

describe("setTierHint", () => {
  it("updates a chunk's tier hint", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    expect(plan.getChunk("a")?.tierHint).toBe("cheap");
    plan.setTierHint("a", "strong");
    expect(plan.getChunk("a")?.tierHint).toBe("strong");
  });
});

describe("redecompose (session-scoped)", () => {
  it("retires the escalated chunk, drops its edges, adds replacements within the session", () => {
    plan.createDecomposition({
      feature: FEATURE,
      session: { id: "S1" },
      chunks: [chunk("a"), chunk("b")],
      edges: [{ from: "a", to: "b" }],
    });
    plan.transition("a", "dispatched");
    plan.transition("a", "escalated");

    plan.redecompose(
      "a",
      [chunk("a1"), chunk("a2")],
      [{ from: "a1", to: "a2" }, { from: "a2", to: "b" }],
    );

    expect(plan.getChunk("a")?.state).toBe("superseded");
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "b", "a1", "a2"]);
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a1"]); // a1→a2→b
  });
});

describe("the dispatch seam (service binds the two repos)", () => {
  it("links a chunk to a dispatch and flows an outcome back", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    const c = plan.getChunk("a")!;
    dispatch.create({ id: "disp-a", issueId: "a", title: c.intent, branch: "agent/a", spec: "spec" });
    plan.linkDispatch("a", "disp-a");
    expect(plan.getChunk("a")?.state).toBe("dispatched");
    expect(plan.getChunk("a")?.dispatchId).toBe("disp-a");

    dispatch.transition("disp-a", "building");
    dispatch.transition("disp-a", "review");
    dispatch.transition("disp-a", "done");
    plan.recordOutcome("a", "done");
    expect(plan.getChunk("a")?.state).toBe("done");
  });

  it("enforces the cross-context FK — linking to a missing dispatch is rejected", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    expect(() => plan.linkDispatch("a", "ghost")).toThrow();
    expect(plan.getChunk("a")?.state).toBe("planned"); // rolled back
  });
});
