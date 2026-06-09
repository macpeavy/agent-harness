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
    sessionId: "S1",
    surface: `src/${id}.ts`,
    intent: `do ${id}`,
    contract: `export function ${id}(): void`,
    acceptance: `${id}.test.ts passes`,
    ...over,
  };
}

// Meta-decompose a feature into one session (S1), then decompose that session — the two-level
// flow (ADR 0020), via the service.
function decompose(chunks: CreateChunk[], edges: { from: string; to: string }[] = []): void {
  service.metaDecompose({ feature: FEATURE, sessions: [{ id: "S1" }] });
  service.decompose({ sessionId: "S1", chunks, edges });
}

// Drive a dispatch to a terminal/parked state the way the daemon would.
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
  it("folds in the optional sections only when present", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a", { dataShapes: "X = { n: number }", preResolved: "use Drizzle" }));
    const spec = specFromChunk(plan.getChunk("a") as Chunk);
    expect(spec).toContain("[src/a.ts] do a");
    expect(spec).toContain("## Data shapes\nX = { n: number }");
    expect(spec).not.toContain("## Out of scope");
  });
});

describe("outcomeFor", () => {
  it("maps terminal/parked dispatch states to chunk outcomes and in-flight ones to null", () => {
    expect(outcomeFor("done")).toBe("done");
    expect(outcomeFor("escalated")).toBe("escalated");
    expect(outcomeFor("failed")).toBe("failed");
    expect(outcomeFor("building")).toBeNull();
  });
});

describe("buildDirect (small-feature path, ADR 0026)", () => {
  it("writes one session + one chunk, no edges — then dispatches build → review → done", () => {
    const r = service.buildDirect({
      feature: FEATURE,
      sessionId: "S1",
      locEstimate: 180,
      chunk: { id: "whole", surface: "src/viewer.ts", intent: "the small feature", contract: "x", acceptance: "t" },
    });
    expect(r).toEqual({ featureId: "F1", sessionId: "S1", chunkId: "whole" });

    // Exactly one session, one chunk, NO decomposition fan-out, cheap tier by default.
    expect(plan.listSessions("F1").map((s) => s.id)).toEqual(["S1"]);
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["whole"]);
    expect(plan.listEdges("S1")).toEqual([]);
    expect(plan.getChunk("whole")?.tierHint).toBe("cheap");

    // The lone chunk dispatches and drives to done like any other — one build, one review.
    const made = service.dispatchReady("S1");
    expect(made).toHaveLength(1);
    driveTo("whole", "done");
    service.recordOutcomes("S1");
    expect(plan.getChunk("whole")?.state).toBe("done");
  });

  it("is plan-only — buildDirect does not approve the feature (dispatch is the gate)", () => {
    service.buildDirect({
      feature: FEATURE,
      sessionId: "S1",
      chunk: { id: "whole", surface: "src/v.ts", intent: "i", contract: "c", acceptance: "a" },
    });
    expect(plan.getFeature("F1")?.state).toBe("planning");
  });
});

describe("metaDecompose + decompose (two-level, ADR 0020)", () => {
  it("meta-decomposes into sessions, then decomposes a session and returns a summary", () => {
    const meta = service.metaDecompose({ feature: FEATURE, sessions: [{ id: "S1", locEstimate: 900 }, { id: "S2" }] });
    expect(meta).toEqual({ featureId: "F1", sessionIds: ["S1", "S2"] });
    expect(plan.getSession("S1")?.locEstimate).toBe(900);

    const result = service.decompose({ sessionId: "S1", chunks: [chunk("a"), chunk("b")], edges: [{ from: "a", to: "b" }] });
    expect(result).toEqual({ featureId: "F1", sessionId: "S1", chunkIds: ["a", "b"], edgeCount: 1 });
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a"]);
  });

  it("rejects a cyclic DAG before writing anything", () => {
    service.metaDecompose({ feature: FEATURE, sessions: [{ id: "S1" }] });
    expect(() =>
      service.decompose({
        sessionId: "S1",
        chunks: [chunk("a"), chunk("b")],
        edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
      }),
    ).toThrow("invalid chunk-DAG");
    expect(plan.listChunks("S1")).toEqual([]); // nothing written
  });

  it("decompose throws for an unknown session", () => {
    expect(() => service.decompose({ sessionId: "ghost", chunks: [chunk("a")], edges: [] })).toThrow("no session");
  });
});

describe("dispatchReady (session-scoped, feature-level approval)", () => {
  it("approves the feature + advances the session, materialising its ready chunks", () => {
    decompose([chunk("a")]); // feature + session planning

    const made = service.dispatchReady("S1"); // first dispatch = approval

    expect(made).toEqual([{ chunkId: "a", dispatchId: "a" }]);
    expect(plan.getChunk("a")?.state).toBe("dispatched");
    expect(plan.getFeature("F1")?.state).toBe("building"); // planning → ready → building
    expect(plan.getSession("S1")?.state).toBe("building");
  });

  it("respects the session DAG — only dependency-satisfied chunks dispatch", () => {
    decompose([chunk("a"), chunk("b")], [{ from: "a", to: "b" }]);
    const made = service.dispatchReady("S1");
    expect(made.map((m) => m.chunkId)).toEqual(["a"]);
    expect(plan.getChunk("b")?.state).toBe("planned");
  });

  it("carries the chunk's tierHint onto its dispatch", () => {
    decompose([chunk("a", { tierHint: "strong" })]);
    service.dispatchReady("S1");
    expect(dispatch.get("a")?.tier).toBe("strong");
  });

  it("throws for an unknown session", () => {
    expect(() => service.dispatchReady("nope")).toThrow("no session");
  });
});

describe("recordOutcomes (session-scoped) + completion", () => {
  it("flows outcomes back and moves the session to review (build complete, awaiting the owner)", () => {
    decompose([chunk("a"), chunk("b")]);
    service.dispatchReady("S1");
    driveTo("a", "done");
    driveTo("b", "done");

    const flowed = service.recordOutcomes("S1");
    expect(flowed).toContainEqual({ chunkId: "a", outcome: "done" });
    expect(plan.getSession("S1")?.state).toBe("review"); // NOT done — the PR awaits the owner
    expect(plan.getFeature("F1")?.state).toBe("building"); // the feature holds until the merge
  });

  it("closes the session on the owner's merge, completing the feature", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    driveTo("a", "done");
    service.recordOutcomes("S1");
    expect(plan.getSession("S1")?.state).toBe("review");

    const { featureId } = service.closeSession("S1"); // the owner merged the PR
    expect(featureId).toBe("F1");
    expect(plan.getSession("S1")?.state).toBe("done");
    expect(plan.getFeature("F1")?.state).toBe("done"); // the feature's only session is merged
  });

  it("closeSession is idempotent and rejects a session that isn't in review", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    expect(() => service.closeSession("S1")).toThrow("not review"); // still building
    driveTo("a", "done");
    service.recordOutcomes("S1");
    service.closeSession("S1");
    expect(() => service.closeSession("S1")).not.toThrow(); // idempotent once done
  });

  it("leaves the feature building while another session is unmerged", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.createSession({ id: "S2", featureId: "F1" });
    plan.addChunk(chunk("a", { sessionId: "S1" }));
    plan.addChunk(chunk("b", { sessionId: "S2" }));

    service.dispatchReady("S1");
    driveTo("a", "done");
    service.recordOutcomes("S1");
    service.closeSession("S1"); // S1 merged

    expect(plan.getSession("S1")?.state).toBe("done");
    expect(plan.getFeature("F1")?.state).toBe("building"); // S2 still open
  });
});

describe("addressReview (owner-review → amend, ADR 0020 slice 4b)", () => {
  // Build a session to `review` with two chunks done + merged, and a PR linked.
  function sessionInReview(): void {
    decompose([chunk("a"), chunk("b")]);
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 7, prUrl: "http://pr/7" });
    service.dispatchReady("S1");
    driveTo("a", "done");
    driveTo("b", "done");
    service.recordOutcomes("S1");
  }

  it("routes an inline comment to its chunk and reopens that chunk's dispatch to amend", () => {
    sessionInReview();
    const result = service.addressReview("S1", [{ path: "src/a.ts", body: "rename foo", author: "owner" }]);

    expect(result.reopened).toEqual([{ chunkId: "a", dispatchId: "a" }]);
    expect(result.unrouted).toEqual([]);
    const d = dispatch.get("a");
    expect(d?.state).toBe("amending");
    expect(d?.pendingFindings).toContain("rename foo");
    expect(d?.pendingFindings).toContain("src/a.ts");
    expect(dispatch.get("b")?.state).toBe("done"); // untouched
  });

  it("groups multiple notes on one file into a single reopen", () => {
    sessionInReview();
    const result = service.addressReview("S1", [
      { path: "src/a.ts", body: "first note" },
      { path: "src/a.ts", body: "second note" },
    ]);

    expect(result.reopened).toEqual([{ chunkId: "a", dispatchId: "a" }]);
    const findings = dispatch.get("a")?.pendingFindings ?? "";
    expect(findings).toContain("first note");
    expect(findings).toContain("second note");
  });

  it("surfaces general notes and unknown-file notes to the chief (unrouted), reopening nothing", () => {
    sessionInReview();
    const result = service.addressReview("S1", [
      { path: null, body: "overall this needs a rethink" },
      { path: "src/ghost.ts", body: "comment on a file no chunk owns" },
    ]);

    expect(result.reopened).toEqual([]);
    expect(result.unrouted).toHaveLength(2);
    expect(result.unrouted[0]?.reason).toContain("general review note");
    expect(result.unrouted[1]?.reason).toContain("no chunk owns src/ghost.ts");
  });

  it("doesn't reopen a chunk whose dispatch isn't done — surfaces it instead", () => {
    decompose([chunk("a"), chunk("b")]);
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 7, prUrl: "http://pr/7" });
    service.dispatchReady("S1");
    driveTo("a", "done");
    driveTo("b", "done");
    service.recordOutcomes("S1"); // session → review
    // a is still in flight (its dispatch reopened by a prior review, say) — force it:
    dispatch.reopenForReview("a", "prior");
    const result = service.addressReview("S1", [{ path: "src/a.ts", body: "another note" }]);

    expect(result.reopened).toEqual([]);
    expect(result.unrouted[0]?.reason).toContain("not done");
  });

  it("throws addressing a session that isn't in review", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1"); // session building, not review
    expect(() => service.addressReview("S1", [])).toThrow("not review");
  });

  it("sessionPrNumber returns the PR for a review session", () => {
    sessionInReview();
    expect(service.sessionPrNumber("S1")).toBe(7);
  });

  it("sessionPrNumber throws for a session not in review", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    expect(() => service.sessionPrNumber("S1")).toThrow("not review");
  });
});

describe("recordOutcomes — failure branch (ADR 0023 row 7)", () => {
  it("moves the session to needs-attention within one tick when a chunk parks — never wedges in building", () => {
    decompose([chunk("a"), chunk("b")]);
    service.dispatchReady("S1");
    driveTo("a", "done");
    driveTo("b", "escalated"); // b parked (e.g. a no-op build)
    service.recordOutcomes("S1");

    expect(plan.getChunk("b")?.state).toBe("escalated");
    expect(plan.getSession("S1")?.state).toBe("needs-attention"); // NOT building, NOT review
  });

  it("a parked chunk's session is routable and resumes to building once the chief promotes it", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    dispatch.transition("a", "building");
    dispatch.escalate("a", "no-op"); // parked as a no-op (the C2 case)
    service.recordOutcomes("S1");
    expect(plan.getSession("S1")?.state).toBe("needs-attention");
    expect(plan.getChunk("a")?.state).toBe("escalated"); // routable

    service.promote("a"); // chief routes the no-op-parked chunk → re-dispatched
    service.recordOutcomes("S1");
    expect(plan.getSession("S1")?.state).toBe("building"); // resumed, no longer wedged
  });
});

describe("abandonFeature (the operator kill switch, ADR 0009/0019)", () => {
  it("transitions the feature + its sessions + chunks + dispatches to abandoned, returning the PRs", () => {
    decompose([chunk("a"), chunk("b")]);
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 9, prUrl: "http://pr/9" });
    service.dispatchReady("S1"); // a, b dispatched

    const result = service.abandonFeature("F1");

    expect(result.alreadyAbandoned).toBe(false);
    expect(result.dispatchesAbandoned).toBe(2);
    expect(result.sessions).toEqual([{ id: "S1", branch: "session-main-S1", prNumber: 9 }]);
    expect(plan.getFeature("F1")?.state).toBe("abandoned");
    expect(plan.getSession("S1")?.state).toBe("abandoned");
    expect(plan.getChunk("a")?.state).toBe("abandoned");
    expect(plan.getChunk("b")?.state).toBe("abandoned");
    expect(dispatch.get("a")?.state).toBe("abandoned");
    expect(dispatch.get("b")?.state).toBe("abandoned");
  });

  it("works from any state — including a chunk already done/escalated", () => {
    decompose([chunk("a"), chunk("b")]);
    service.dispatchReady("S1");
    driveTo("a", "done");
    driveTo("b", "escalated");
    service.recordOutcomes("S1");

    service.abandonFeature("F1");
    expect(plan.getChunk("a")?.state).toBe("abandoned"); // was done
    expect(plan.getChunk("b")?.state).toBe("abandoned"); // was escalated
    expect(dispatch.get("a")?.state).toBe("abandoned");
  });

  it("is idempotent — a second abandon is a no-op", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    service.abandonFeature("F1");

    const second = service.abandonFeature("F1");
    expect(second.alreadyAbandoned).toBe(true);
    expect(second.sessions).toEqual([]);
    expect(second.dispatchesAbandoned).toBe(0);
    expect(plan.getFeature("F1")?.state).toBe("abandoned");
  });

  it("throws for an unknown feature", () => {
    expect(() => service.abandonFeature("ghost")).toThrow("no feature ghost");
  });
});

describe("promote", () => {
  it("marks an escalated chunk strong and re-dispatches it on a fresh id", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    driveTo("a", "escalated");
    service.recordOutcomes("S1");
    expect(plan.getChunk("a")?.state).toBe("escalated");

    const made = service.promote("a");
    expect(made).toEqual({ chunkId: "a", dispatchId: "a-r2" });
    expect(plan.getChunk("a")?.tierHint).toBe("strong");
    expect(dispatch.get("a-r2")?.tier).toBe("strong");
    expect(dispatch.get("a-r2")?.issueId).toBe("a-r2"); // branch derivation stays consistent
  });

  it("refuses to promote a chunk that isn't escalated", () => {
    decompose([chunk("a")]);
    expect(() => service.promote("a")).toThrow("not escalated");
  });
});

describe("redecompose (session-scoped)", () => {
  it("retires the chunk and the replacements dispatch through the normal path", () => {
    decompose([chunk("a"), chunk("b")], [{ from: "a", to: "b" }]);
    service.dispatchReady("S1");
    driveTo("a", "escalated");
    service.recordOutcomes("S1");

    const d = service.redecompose("a", {
      chunks: [chunk("a1"), chunk("a2")],
      edges: [{ from: "a1", to: "a2" }, { from: "a2", to: "b" }],
    });
    expect(d).toEqual({ featureId: "F1", sessionId: "S1", chunkIds: ["a1", "a2"], edgeCount: 2 });
    expect(plan.getChunk("a")?.state).toBe("superseded");
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a1"]);
  });

  it("rejects a cyclic re-decomposition", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    driveTo("a", "escalated");
    service.recordOutcomes("S1");
    expect(() =>
      service.redecompose("a", {
        chunks: [chunk("a1"), chunk("a2")],
        edges: [{ from: "a1", to: "a2" }, { from: "a2", to: "a1" }],
      }),
    ).toThrow("invalid re-decomposition");
    expect(plan.getChunk("a")?.state).toBe("escalated"); // unchanged
  });
});

describe("status (feature → sessions → chunks)", () => {
  it("digests each session with its chunks, readout, and escalations", () => {
    decompose([chunk("a"), chunk("b")]);
    service.dispatchReady("S1");
    driveTo("a", "done");
    dispatch.transition("b", "building"); // in flight

    const s = service.status("F1");
    expect(s.feature.state).toBe("building");
    expect(s.sessions).toHaveLength(1);
    const sess = s.sessions[0]!;
    expect(sess.session.id).toBe("S1");
    expect(sess.chunks.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(sess.readout.total).toBe(2);
    expect(sess.readout.reachedReady).toBe(1);
  });

  it("surfaces a session's parked escalations with their kind", () => {
    decompose([chunk("a")]);
    service.dispatchReady("S1");
    driveTo("a", "escalated");

    const s = service.status("F1");
    expect(s.sessions[0]?.escalations).toEqual([{ chunkId: "a", dispatchId: "a", kind: "re-decompose", reason: null }]);
  });

  it("reconciles real per-leg cost + a chief-attribution window (ADR 0026)", () => {
    decompose([chunk("a"), chunk("b")]);
    service.dispatchReady("S1");
    // The daemon records real per-leg spend onto the dispatch rows; sum them across the feature.
    dispatch.setCost("a", "build", 0.01);
    dispatch.setCost("a", "review", 0.03);
    dispatch.setCost("b", "build", 0.02);
    dispatch.setCost("b", "amend", 0.005);

    const s = service.status("F1");
    expect(s.cost.buildUsd).toBeCloseTo(0.03, 6); // a:0.01 + b:0.02
    expect(s.cost.reviewUsd).toBeCloseTo(0.03, 6);
    expect(s.cost.amendUsd).toBeCloseTo(0.005, 6);
    // The window opens at feature creation (so the chief's pre-dispatch planning spend is in it)
    // and closes no earlier than the latest dispatch activity.
    const feature = plan.getFeature("F1")!;
    expect(s.cost.window.start).toBe(feature.createdAt);
    expect(s.cost.window.end).toBeGreaterThanOrEqual(feature.createdAt);
  });
});

describe("approve (the owner gate, ADR 0020 slice 2b)", () => {
  it("moves the feature planning → ready and is idempotent", () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });

    expect(service.approve("S1")).toEqual({ featureId: "F1" });
    expect(plan.getFeature("F1")?.state).toBe("ready");
    // idempotent — approving again is a no-op, not an illegal transition.
    expect(() => service.approve("S1")).not.toThrow();
    expect(plan.getFeature("F1")?.state).toBe("ready");
  });

  it("throws for an unknown session", () => {
    expect(() => service.approve("ghost")).toThrow("no session");
  });
});

describe("addChunk (incremental add before approval, ADR 0020 §5b)", () => {
  it("adds a chunk to an existing session, wiring it with edges", () => {
    decompose([chunk("a")]); // S1 has a
    const r = service.addChunk({ sessionId: "S1", chunk: chunk("b"), edges: [{ from: "a", to: "b" }] });
    expect(r).toEqual({ featureId: "F1", sessionId: "S1", chunkId: "b" });
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a"]); // b gated on a→b
  });

  it("rejects an add that would create a cycle", () => {
    decompose([chunk("a")]);
    expect(() =>
      service.addChunk({ sessionId: "S1", chunk: chunk("b"), edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] }),
    ).toThrow("invalid chunk addition");
    expect(plan.getChunk("b")).toBeNull(); // nothing written
  });

  it("throws for an unknown session", () => {
    expect(() => service.addChunk({ sessionId: "ghost", chunk: chunk("b") })).toThrow("no session");
  });
});

describe("addSession + addEdge (full edit symmetry, ADR 0020 §5b)", () => {
  it("adds a session to an existing feature while planning", () => {
    decompose([chunk("a")]); // F1 / S1
    service.addSession("F1", "S2", 600);
    expect(plan.listSessions("F1").map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(plan.getSession("S2")?.locEstimate).toBe(600);
  });

  it("adds a dependency edge between two chunks of the same session", () => {
    decompose([chunk("a"), chunk("b")]); // S1 has a, b — no edges
    service.addEdge("a", "b");
    expect(plan.listEdges("S1")).toEqual([{ from: "a", to: "b" }]);
    expect(plan.readyChunks("S1").map((c) => c.id)).toEqual(["a"]); // b now gated on a→b
  });

  it("rejects an edge that spans sessions", () => {
    decompose([chunk("a")]); // S1 has a
    service.addSession("F1", "S2");
    service.addChunk({ sessionId: "S2", chunk: chunk("b", { sessionId: "S2" }) });
    expect(() => service.addEdge("a", "b")).toThrow("spans sessions");
    expect(plan.listEdges("S1")).toEqual([]);
  });

  it("throws adding an edge from an unknown chunk", () => {
    decompose([chunk("a")]);
    expect(() => service.addEdge("ghost", "a")).toThrow("no chunk ghost");
  });
});
