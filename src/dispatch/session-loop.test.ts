import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLoop, type SessionLegs } from "./session-loop";
import { PlanDispatchService } from "./plan-dispatch";
import { PlanRepository, type CreateChunk } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";
import type { SubstrateConfig } from "../config";

const CONFIG = {
  repoPath: "/repo",
  ghRepo: "acme/widgets",
  worktreeRoot: "/tmp/ah-test-wt",
  builderAgent: "builder",
  builderStrongAgent: "builder-strong",
  reviewerAgent: "reviewer",
  amendCap: 3,
  agentIdleMs: 120_000,
  agentTimeoutMs: 1_800_000,
} satisfies SubstrateConfig;

let dir: string;
let plan: PlanRepository;
let dispatch: DispatchRepository;
let service: PlanDispatchService;
let opened: string[];
let legs: SessionLegs;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-sloop-"));
  const dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
  service = new PlanDispatchService(plan, dispatch);
  opened = [];
  // Fake session-open: records the call and returns canned branch/PR linkage (no real git).
  legs = {
    async open(sessionId) {
      opened.push(sessionId);
      return { branch: `session-main-${sessionId}`, prNumber: 100, prUrl: `http://pr/${sessionId}` };
    },
  };
});

afterEach(() => {
  plan.close();
  dispatch.close();
  rmSync(dir, { recursive: true, force: true });
});

const FEATURE = { id: "F1", title: "A feature", description: "the owner's intent" };

function chunk(id: string, sessionId = "S1"): CreateChunk {
  return { id, sessionId, surface: `src/${id}.ts`, intent: `do ${id}`, contract: "c", acceptance: "t" };
}

const loop = () => new SessionLoop(plan, service, CONFIG, legs);

// Drive a chunk's dispatch to done the way the daemon would.
function landChunk(chunkId: string): void {
  dispatch.transition(chunkId, "building");
  dispatch.transition(chunkId, "review");
  dispatch.transition(chunkId, "done");
}

describe("SessionLoop.runOnce", () => {
  it("skips sessions whose feature is still planning (the owner gate)", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));

    const advanced = await loop().runOnce();

    expect(advanced).toBe(0);
    expect(opened).toEqual([]); // not opened — not approved
    expect(plan.getChunk("a")?.state).toBe("planned");
  });

  it("opens session-main once and launches the ready chunks of an approved feature", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    service.approve("S1"); // feature → ready

    await loop().runOnce();

    expect(opened).toEqual(["S1"]); // opened once
    expect(plan.getSession("S1")?.branch).toBe("session-main-S1");
    expect(plan.getSession("S1")?.prNumber).toBe(100);
    expect(plan.getChunk("a")?.state).toBe("dispatched");
    // dispatches carry the session-main branch so the daemon can merge into it (slice 2a).
    expect(dispatch.get("a")?.sessionBranch).toBe("session-main-S1");
    expect(plan.getFeature("F1")?.state).toBe("building");
  });

  it("does not re-open an already-open session on a later tick", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    service.approve("S1");

    await loop().runOnce();
    await loop().runOnce();

    expect(opened).toEqual(["S1"]); // still just once
  });

  it("advances the DAG as chunks land, then moves the session to review (awaiting the owner)", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("S1", "a", "b"); // b depends on a
    service.approve("S1");

    await loop().runOnce(); // opens + dispatches the root a (b is gated)
    expect(plan.getChunk("a")?.state).toBe("dispatched");
    expect(plan.getChunk("b")?.state).toBe("planned");

    landChunk("a");
    await loop().runOnce(); // reaps a → done, unblocks + dispatches b
    expect(plan.getChunk("a")?.state).toBe("done");
    expect(plan.getChunk("b")?.state).toBe("dispatched");

    landChunk("b");
    await loop().runOnce(); // reaps b → session reaches review (build complete, PR awaits owner)
    expect(plan.getSession("S1")?.state).toBe("review");
    expect(plan.getFeature("F1")?.state).toBe("building"); // the feature holds until the merge

    // A later tick leaves the review session untouched — nothing ready, no re-open, no re-transition.
    await loop().runOnce();
    expect(plan.getSession("S1")?.state).toBe("review");
    expect(opened).toEqual(["S1"]); // not re-opened
  });

  it("ignores terminal sessions", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.transitionFeature("F1", "ready");
    plan.transitionSession("S1", "ready");
    plan.transitionSession("S1", "building");
    plan.transitionSession("S1", "review");
    plan.transitionSession("S1", "done");

    const advanced = await loop().runOnce();
    expect(advanced).toBe(0);
    expect(opened).toEqual([]);
  });

  // AGENT-38 part 3: count REAL progress, not "processed a session," so the loop sleeps when
  // nothing changed (the CPU-peg fix) — but parked sessions are still re-checked so they recover.
  it("counts progress, not processing — a no-op tick over an in-flight session returns 0 (loop sleeps)", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    service.approve("S1");

    const first = await loop().runOnce(); // opens S1 + dispatches a → real progress
    expect(first).toBeGreaterThan(0);

    const second = await loop().runOnce(); // a is in-flight (queued), nothing changed
    expect(second).toBe(0); // → the poll loop sleeps instead of busy-spinning
  });

  it("a parked session returns 0 each tick, then resumes (advanced>0) when the chief routes it", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    service.approve("S1");
    await loop().runOnce(); // opens + dispatches a
    dispatch.transition("a", "building");
    dispatch.escalate("a", "no-op"); // the build parked (the C2 case)

    const park = await loop().runOnce(); // reaps a→escalated, S1→needs-attention (a transition)
    expect(plan.getSession("S1")?.state).toBe("needs-attention");
    expect(park).toBeGreaterThan(0); // the transition is real progress

    const idle = await loop().runOnce(); // still parked, nothing changes
    expect(idle).toBe(0); // loop sleeps — no busy-spin on a parked session

    service.promote("a"); // the chief routes it
    const resume = await loop().runOnce(); // S1: needs-attention → building, within one tick
    expect(plan.getSession("S1")?.state).toBe("building");
    expect(resume).toBeGreaterThan(0);
  });

  // ADR 0026 decision 2: the runtime budget guard parks (never hard-kills) a feature over budget.
  it("parks a building session when its real total (chief + legs) crosses the budget — work preserved", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.addEdge("S1", "a", "b"); // b is gated behind a, so it only dispatches after a lands
    service.approve("S1");
    await loop().runOnce(); // opens + dispatches the ready root a; b still planned (gated)
    expect(plan.getChunk("a")?.state).toBe("dispatched");
    expect(plan.getChunk("b")?.state).toBe("planned");

    service.setBudget("F1", 1.0); // a tight budget
    dispatch.setCost("a", "build", 0.5); // real recorded legs so far
    // Inject a chief spend that pushes the total over: legs 0.5 + chief 0.8 = 1.3 > 1.0.
    const guarded = new SessionLoop(plan, service, CONFIG, legs, () => 0.8);

    const advanced = await guarded.runOnce();

    expect(advanced).toBeGreaterThan(0); // the park is real progress
    expect(plan.getSession("S1")?.state).toBe("needs-attention"); // parked, not hard-killed
    expect(plan.getSession("S1")?.budgetExceededUsd).toBeCloseTo(1.3, 6);
    expect(plan.getChunk("b")?.state).toBe("planned"); // NO new chunk dispatched (spend stopped)
    expect(plan.getChunk("a")?.state).toBe("dispatched"); // the already-launched work is untouched

    // Raising the budget resumes it; with a landed, b (gated behind a) now dispatches.
    service.raiseBudget("F1", 5.0);
    landChunk("a");
    await guarded.runOnce();
    expect(plan.getSession("S1")?.state).toBe("building"); // resumed
    expect(plan.getChunk("b")?.state).toBe("dispatched"); // and dispatch continues
  });

  it("does not trip when a feature has no budget set (opt-in guard)", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    service.approve("S1");
    await loop().runOnce();
    dispatch.setCost("a", "build", 9999); // huge spend, but no budget set
    const guarded = new SessionLoop(plan, service, CONFIG, legs, () => 9999);
    await guarded.runOnce();
    expect(plan.getSession("S1")?.state).not.toBe("needs-attention"); // never parked
  });

  // The priority fix: a throw in one session's tick must never exit the loop process.
  it("survives a session whose advance throws — records the error and advances the others", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.createSession({ id: "S2", featureId: "F1" });
    plan.addChunk(chunk("a", "S1"));
    plan.addChunk(chunk("b", "S2"));
    service.approve("S1");

    // The open leg throws for S1 (e.g. a gh/git hiccup), succeeds for S2.
    const throwingLegs: SessionLegs = {
      async open(sessionId) {
        if (sessionId === "S1") throw new Error("gh pr create boom");
        opened.push(sessionId);
        return { branch: `session-main-${sessionId}`, prNumber: 100, prUrl: `http://pr/${sessionId}` };
      },
    };
    const loopWithThrow = new SessionLoop(plan, service, CONFIG, throwingLegs);

    const advanced = await loopWithThrow.runOnce(); // must NOT throw

    expect(advanced).toBe(1); // S2 advanced; S1's throw was caught, not counted
    expect(opened).toEqual(["S2"]); // S2 got opened despite S1 blowing up
    expect(plan.getChunk("b")?.state).toBe("dispatched"); // S2 made real progress
    expect(plan.getSession("S1")?.lastError).toContain("gh pr create boom"); // recorded for the chief
    expect(plan.getChunk("a")?.state).toBe("planned"); // S1 made no progress, left to retry
  });

  it("clears a session's recorded error on a later clean tick", async () => {
    plan.createFeature(FEATURE);
    plan.createSession({ id: "S1", featureId: "F1" });
    plan.addChunk(chunk("a"));
    service.approve("S1");

    let boom = true;
    const flakyLegs: SessionLegs = {
      async open(sessionId) {
        if (boom) throw new Error("transient");
        opened.push(sessionId);
        return { branch: `session-main-${sessionId}`, prNumber: 100, prUrl: `http://pr/${sessionId}` };
      },
    };
    const flakyLoop = new SessionLoop(plan, service, CONFIG, flakyLegs);

    await flakyLoop.runOnce();
    expect(plan.getSession("S1")?.lastError).toContain("transient");

    boom = false; // the hiccup clears
    await flakyLoop.runOnce();
    expect(plan.getSession("S1")?.lastError).toBeNull(); // cleared on the clean tick
    expect(opened).toEqual(["S1"]);
  });
});
