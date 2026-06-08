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
  agentTimeoutMs: 600_000,
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
