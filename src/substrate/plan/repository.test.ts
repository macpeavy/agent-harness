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

describe("features: create / list / get", () => {
  it("listAllFeatures on an empty db returns []", () => {
    expect(plan.listAllFeatures()).toEqual([]);
  });

  it("listAllFeatures returns all features oldest-first", () => {
    plan.createMetaDecomposition({ feature: FEATURE, sessions: [{ id: "S1" }] });
    plan.createMetaDecomposition({
      feature: { id: "F2", title: "Another feature", description: "second intent" },
      sessions: [{ id: "S2" }],
    });

    const features = plan.listAllFeatures();
    expect(features).toHaveLength(2);
    expect(features.map((f) => f.id)).toEqual(["F1", "F2"]);
  });
});

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
    plan.transitionSession("S1", "review"); // build complete → PR awaits the owner (ADR 0020 §6)
    plan.transitionSession("S1", "done"); // the owner merges the PR
    expect(plan.getSession("S1")?.state).toBe("done");
  });

  it("rejects building → done (the owner's merge gate sits between)", () => {
    seedFeatureSession();
    plan.transitionSession("S1", "ready");
    plan.transitionSession("S1", "building");
    expect(() => plan.transitionSession("S1", "done")).toThrow("illegal session transition building → done");
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

describe("createMetaDecomposition + addChunkDag (two-level, ADR 0020)", () => {
  it("meta-decomposes a feature into sessions, then fills a session's DAG", () => {
    plan.createMetaDecomposition({ feature: FEATURE, sessions: [{ id: "S1", locEstimate: 800 }, { id: "S2" }] });

    expect(plan.getFeature("F1")?.state).toBe("planning");
    expect(plan.listSessions("F1").map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(plan.getSession("S1")?.locEstimate).toBe(800);

    plan.addChunkDag("S1", [chunk("a"), chunk("b")], [{ from: "a", to: "b" }]);
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a"]); // a→b edge landed
  });

  it("rolls back a session's DAG on a mid-write failure (atomic)", () => {
    plan.createMetaDecomposition({ feature: FEATURE, sessions: [{ id: "S1" }] });
    expect(() => plan.addChunkDag("S1", [chunk("a"), chunk("a")], [])).toThrow(); // dup id → PK abort
    expect(plan.listChunks("S1")).toEqual([]);
  });

  it("addChunkDag is planning-amendable — rejected once the feature is approved", () => {
    plan.createMetaDecomposition({ feature: FEATURE, sessions: [{ id: "S1" }] });
    plan.transitionFeature("F1", "ready");
    expect(() => plan.addChunkDag("S1", [chunk("a")], [])).toThrow("not amendable");
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
    plan.createMetaDecomposition({ feature: FEATURE, sessions: [{ id: "S1" }] });
    plan.addChunkDag("S1", [chunk("a"), chunk("b")], [{ from: "a", to: "b" }]);
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

describe("planning-amendable: revise + prune (ADR 0020 §5b)", () => {
  it("revises a planned chunk's spec (only the given fields)", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    plan.reviseChunk("a", { contract: "export function a(x: number): void", tierHint: "strong" });
    const c = plan.getChunk("a");
    expect(c?.contract).toBe("export function a(x: number): void");
    expect(c?.tierHint).toBe("strong");
    expect(c?.surface).toBe("src/a.ts"); // untouched
  });

  it("removes a planned chunk and the edges touching it", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("S1", "a", "b");
    plan.removeChunk("a");
    expect(plan.getChunk("a")).toBeNull();
    expect(plan.listEdges("S1")).toEqual([]); // a→b gone with a
    expect(plan.getChunk("b")).not.toBeNull(); // b stays
  });

  it("removes a session and its whole sub-plan", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.createSession({ id: "S2", featureId: "F1" });
    plan.addChunk(chunk("a", { sessionId: "S1" }));
    plan.addChunk(chunk("b", { sessionId: "S1" }));
    plan.addEdge("S1", "a", "b");
    plan.removeSession("S1");
    expect(plan.getSession("S1")).toBeNull();
    expect(plan.listChunks("S1")).toEqual([]);
    expect(plan.listEdges("S1")).toEqual([]);
    expect(plan.getSession("S2")).not.toBeNull(); // sibling untouched
  });

  it("removes a single edge", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("S1", "a", "b");
    plan.removeEdge("a", "b");
    expect(plan.listEdges("S1")).toEqual([]);
    expect(plan.getChunk("a")).not.toBeNull(); // chunks stay; only the edge went
  });

  it("freezes revise + prune once the feature leaves planning", () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("S1", "a", "b");
    plan.transitionFeature("F1", "ready"); // approved

    expect(() => plan.reviseChunk("a", { contract: "x" })).toThrow("not amendable");
    expect(() => plan.removeChunk("a")).toThrow("not amendable");
    expect(() => plan.removeSession("S1")).toThrow("not amendable");
    expect(() => plan.removeEdge("a", "b")).toThrow("not amendable");
  });

  it("throws for unknown targets", () => {
    seedFeatureSession();
    expect(() => plan.reviseChunk("ghost", { contract: "x" })).toThrow("no chunk ghost");
    expect(() => plan.removeSession("ghost")).toThrow("no session ghost");
    expect(() => plan.removeEdge("x", "y")).toThrow("no edge x->y");
  });
});

describe("signaled_at: the notify pass's exactly-once key (ADR 0024)", () => {
  // Walk S1 to 'building' so it can enter the signalling states.
  function seedBuilding(): void {
    seedFeatureSession();
    plan.transitionFeature("F1", "ready");
    plan.transitionSession("S1", "ready");
    plan.transitionSession("S1", "building");
  }

  it("a new session starts un-signaled", () => {
    seedFeatureSession();
    expect(plan.getSession("S1")?.signaledAt).toBeNull();
  });

  it("stampSignaled sets the stamp; a transition clears it (re-arming the signal)", () => {
    seedBuilding();
    plan.transitionSession("S1", "needs-attention");
    plan.stampSignaled("S1", 1234);
    expect(plan.getSession("S1")?.signaledAt).toBe(1234);

    plan.transitionSession("S1", "building"); // the chief routed it
    expect(plan.getSession("S1")?.signaledAt).toBeNull(); // a re-park will re-signal
  });

  it("stampSignaled throws on an unknown session", () => {
    expect(() => plan.stampSignaled("ghost")).toThrow("no session ghost");
  });

  it("listUnsignaledSessions selects only un-signaled sessions in the given states", () => {
    seedBuilding();
    // A second session must be created while its feature is planning — use a second feature.
    plan.createMetaDecomposition({
      feature: { id: "F2", title: "Another", description: "intent" },
      sessions: [{ id: "S2" }],
    });
    plan.transitionFeature("F2", "ready");
    plan.transitionSession("S2", "ready");
    plan.transitionSession("S2", "building");

    plan.transitionSession("S1", "needs-attention");
    plan.transitionSession("S2", "review");

    let ids = plan.listUnsignaledSessions(["needs-attention", "review"]).map((s) => s.id);
    expect(ids).toEqual(["S1", "S2"]);

    plan.stampSignaled("S1");
    ids = plan.listUnsignaledSessions(["needs-attention", "review"]).map((s) => s.id);
    expect(ids).toEqual(["S2"]); // S1 is stamped; S2 still pending

    expect(plan.listUnsignaledSessions(["needs-attention"]).map((s) => s.id)).toEqual([]); // state filter holds
    expect(plan.listUnsignaledSessions([])).toEqual([]); // empty state list selects nothing
  });
});
