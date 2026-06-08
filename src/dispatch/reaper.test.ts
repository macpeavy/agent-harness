import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reaper, type ReapDeps } from "./reaper";
import { PlanRepository } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";

let dir: string;
let plan: PlanRepository;
let dispatch: DispatchRepository;
let reaped: { sessions: string[]; branches: string[] };
let deps: ReapDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-reaper-"));
  const dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
  reaped = { sessions: [], branches: [] };
  deps = {
    deleteSession: async (id) => void reaped.sessions.push(id),
    deleteBranch: async (b) => void reaped.branches.push(b),
  };
  plan.createFeature({ id: "F1", title: "F", description: "d" });
});

afterEach(() => {
  plan.close();
  dispatch.close();
  rmSync(dir, { recursive: true, force: true });
});

// Create a dispatch linked as chunk `id`'s current attempt, with sessions set.
function linkedDispatch(id: string): void {
  plan.addChunk({ id, featureId: "F1", surface: `src/${id}.ts`, intent: id, contract: "c", acceptance: "t" });
  dispatch.create({ id, issueId: id, title: id, branch: `agent/${id}`, spec: "s" });
  dispatch.setSessions(id, { buildSessionId: `ses_b_${id}`, reviewSessionId: `ses_r_${id}` });
  plan.linkDispatch(id, id);
}

const reaper = () => new Reaper(plan, dispatch, deps);

describe("Reaper.reap", () => {
  it("reaps a done dispatch's sessions, not its branch (the owner's merge deletes that)", async () => {
    linkedDispatch("d1");
    dispatch.transition("d1", "building");
    dispatch.transition("d1", "review");
    dispatch.transition("d1", "done");

    const r = await reaper().reap();

    expect(reaped.sessions.sort()).toEqual(["ses_b_d1", "ses_r_d1"]);
    expect(reaped.branches).toEqual([]);
    expect(r).toEqual({ dispatchesReaped: 1, sessionsReaped: 2, branchesReaped: 0 });
    expect(dispatch.get("d1")?.reapedAt).not.toBeNull();
  });

  it("reaps a failed dispatch's branch, keeps its session for debugging", async () => {
    linkedDispatch("f1");
    dispatch.transition("f1", "building");
    dispatch.transition("f1", "failed");

    await reaper().reap();

    expect(reaped.branches).toEqual(["agent/f1"]);
    expect(reaped.sessions).toEqual([]);
    expect(dispatch.get("f1")?.reapedAt).not.toBeNull();
  });

  it("reaps an orphaned superseded attempt's branch (the chief re-dispatched)", async () => {
    // o1 escalates; a re-dispatch o1-r2 becomes the chunk's current attempt, orphaning o1.
    linkedDispatch("o1");
    dispatch.transition("o1", "building");
    dispatch.escalate("o1", "re-decompose");
    plan.recordOutcome("o1", "escalated"); // the daemon's reap moves the chunk escalated
    dispatch.create({ id: "o1-r2", issueId: "o1-r2", title: "o1", branch: "agent/o1-r2", spec: "s" });
    plan.linkDispatch("o1", "o1-r2"); // chunk now points at o1-r2; o1 is orphaned

    await reaper().reap();

    expect(reaped.branches).toEqual(["agent/o1"]); // only the orphan; o1-r2 is live/current
    expect(reaped.sessions).toEqual([]); // escalated session kept for debugging
    expect(dispatch.get("o1")?.reapedAt).not.toBeNull();
    expect(dispatch.get("o1-r2")?.reapedAt).toBeNull();
  });

  it("leaves a live escalated dispatch (still the current attempt) alone", async () => {
    linkedDispatch("e1");
    dispatch.transition("e1", "building");
    dispatch.escalate("e1", "re-decompose"); // parked, but still the chunk's current attempt

    const r = await reaper().reap();

    expect(reaped.branches).toEqual([]);
    expect(reaped.sessions).toEqual([]);
    expect(r.dispatchesReaped).toBe(0);
    expect(dispatch.get("e1")?.reapedAt).toBeNull();
  });

  it("leaves an in-flight dispatch alone", async () => {
    linkedDispatch("b1");
    dispatch.transition("b1", "building");

    await reaper().reap();

    expect(reaped.sessions).toEqual([]);
    expect(reaped.branches).toEqual([]);
    expect(dispatch.get("b1")?.reapedAt).toBeNull();
  });

  it("is idempotent — a second sweep reaps nothing new", async () => {
    linkedDispatch("d1");
    dispatch.transition("d1", "building");
    dispatch.transition("d1", "review");
    dispatch.transition("d1", "done");

    await reaper().reap();
    reaped.sessions = [];
    const second = await reaper().reap();

    expect(second.dispatchesReaped).toBe(0);
    expect(reaped.sessions).toEqual([]); // not re-deleted
  });
});
