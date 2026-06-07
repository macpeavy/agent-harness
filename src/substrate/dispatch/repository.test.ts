import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchRepository, type CreateDispatch } from "./repository";
import { isTerminal, nonTerminalStates, TRANSITIONS } from "./model";

let dir: string;
let repo: DispatchRepository;

const SEED: CreateDispatch = {
  id: "d1",
  issueId: "AGENT-18",
  title: "Dispatch registry",
  branch: "agent-18-dispatch-registry",
  spec: "Build the dispatch registry per ADR 0009.",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-dispatch-repo-"));
  repo = new DispatchRepository(join(dir, "dispatches.db"));
});

afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the transition graph", () => {
  it("derives the terminal set from the graph, not a hardcoded list", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("amending")).toBe(false);
    // escalated is a paused state, not terminal — it can rewake to building.
    expect(isTerminal("escalated")).toBe(false);
  });

  it("derives non-terminal states from the graph (escalated is paused, not terminal)", () => {
    expect(nonTerminalStates().sort()).toEqual([
      "amending",
      "building",
      "escalated",
      "queued",
      "review",
    ]);
  });

  it("every transition target is itself a known state (no dangling edges)", () => {
    const states = new Set(Object.keys(TRANSITIONS));
    for (const targets of Object.values(TRANSITIONS))
      for (const t of targets) expect(states.has(t)).toBe(true);
  });
});

describe("create / get / list", () => {
  it("creates a dispatch in state 'queued', persisting the spec", () => {
    repo.create(SEED);
    const d = repo.get("d1");
    expect(d?.state).toBe("queued");
    expect(d?.issueId).toBe("AGENT-18");
    expect(d?.amendRounds).toBe(0);
    expect(d?.spec).toBe("Build the dispatch registry per ADR 0009.");
  });

  it("returns null for an unknown id", () => {
    expect(repo.get("nope")).toBeNull();
  });

  it("lists newest first and filters by state", () => {
    repo.create({ ...SEED, id: "d1" });
    repo.create({ ...SEED, id: "d2" });
    repo.transition("d2", "building");

    const all = repo.list();
    expect(all.map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(repo.list({ state: "building" }).map((d) => d.id)).toEqual(["d2"]);
    expect(repo.list({ state: "queued" }).map((d) => d.id)).toEqual(["d1"]);
  });
});

describe("transition", () => {
  it("walks a full valid path queued → building → review → amending → review → done", () => {
    repo.create(SEED);
    for (const to of ["building", "review", "amending", "review", "done"] as const)
      repo.transition("d1", to);
    expect(repo.get("d1")?.state).toBe("done");
  });

  it("rejects an illegal transition and leaves state unchanged", () => {
    repo.create(SEED);
    expect(() => repo.transition("d1", "done")).toThrow("illegal transition queued → done");
    expect(repo.get("d1")?.state).toBe("queued");
  });

  it("rejects a transition out of a terminal state", () => {
    repo.create(SEED);
    repo.transition("d1", "building");
    repo.transition("d1", "failed");
    expect(() => repo.transition("d1", "review")).toThrow("illegal transition failed → review");
  });

  it("throws on a transition for an unknown dispatch", () => {
    expect(() => repo.transition("ghost", "building")).toThrow("no dispatch ghost");
  });
});

describe("escalate", () => {
  it("moves to 'escalated' and records the kind atomically", () => {
    repo.create(SEED);
    repo.transition("d1", "building");
    repo.transition("d1", "review");
    repo.transition("d1", "amending");
    repo.escalate("d1", "re-decompose");

    const d = repo.get("d1");
    expect(d?.state).toBe("escalated");
    expect(d?.escalated).toBe("re-decompose");
  });

  it("rejects escalation from a state with no escalated edge", () => {
    repo.create(SEED);
    expect(() => repo.escalate("d1", "attended")).toThrow("illegal transition queued → escalated");
  });

  it("rewakes from escalated back to building on resolution", () => {
    repo.create(SEED);
    repo.transition("d1", "building");
    repo.escalate("d1", "tier-promote");
    repo.transition("d1", "building"); // rewoken on resolution
    expect(repo.get("d1")?.state).toBe("building");
  });

  it("can abandon an escalated dispatch to failed", () => {
    repo.create(SEED);
    repo.transition("d1", "building");
    repo.escalate("d1", "attended");
    repo.transition("d1", "failed");
    expect(repo.get("d1")?.state).toBe("failed");
  });
});

describe("linking", () => {
  it("links both session ids in one atomic write", () => {
    repo.create(SEED);
    repo.setSessions("d1", { buildSessionId: "sess-build", reviewSessionId: "sess-review" });
    const d = repo.get("d1");
    expect(d?.buildSessionId).toBe("sess-build");
    expect(d?.reviewSessionId).toBe("sess-review");
  });

  it("links a single session id without disturbing the other", () => {
    repo.create(SEED);
    repo.setSessions("d1", { buildSessionId: "sess-build" });
    expect(repo.get("d1")?.reviewSessionId).toBeNull();
    repo.setSessions("d1", { reviewSessionId: "sess-review" });
    expect(repo.get("d1")?.buildSessionId).toBe("sess-build");
  });

  it("links a PR url", () => {
    repo.create(SEED);
    repo.setPr("d1", "https://github.com/macpeavy/agent-harness/pull/41");
    expect(repo.get("d1")?.prUrl).toContain("/pull/41");
  });

  it("throws when linking onto an unknown dispatch", () => {
    expect(() => repo.setPr("ghost", "url")).toThrow("no dispatch ghost");
  });
});

describe("the instrument columns", () => {
  it("records the route", () => {
    repo.create({ ...SEED, route: "builder" });
    expect(repo.get("d1")?.route).toBe("builder");
    repo.setRoute("d1", "builder-alt");
    expect(repo.get("d1")?.route).toBe("builder-alt");
  });

  it("counts amend rounds", () => {
    repo.create(SEED);
    repo.incrementAmendRound("d1");
    repo.incrementAmendRound("d1");
    expect(repo.get("d1")?.amendRounds).toBe(2);
  });

  it("splits cost per leg, accumulating amend cost across rounds", () => {
    repo.create(SEED);
    repo.setCost("d1", "build", 0.004);
    repo.setCost("d1", "review", 0.074);
    repo.setCost("d1", "amend", 0.005);
    repo.setCost("d1", "amend", 0.006);

    const d = repo.get("d1");
    expect(d?.buildCostUsd).toBeCloseTo(0.004, 6);
    expect(d?.reviewCostUsd).toBeCloseTo(0.074, 6);
    expect(d?.amendCostUsd).toBeCloseTo(0.011, 6);
  });

  it("makes the instrument fields queryable for the cheap-able-fraction readout", () => {
    repo.create({ ...SEED, id: "cheap", route: "builder" });
    repo.create({ ...SEED, id: "promoted", route: "builder-alt" });
    repo.transition("promoted", "building");
    repo.transition("promoted", "review");
    repo.transition("promoted", "amending");
    repo.incrementAmendRound("promoted");
    repo.escalate("promoted", "tier-promote");

    const escalated = repo.list({ state: "escalated" });
    expect(escalated.map((d) => d.id)).toEqual(["promoted"]);
    expect(escalated[0]?.escalated).toBe("tier-promote");
    expect(escalated[0]?.amendRounds).toBe(1);
  });
});

describe("resumeIncomplete", () => {
  it("returns non-terminal dispatches (incl. parked-escalated), newest first", () => {
    repo.create({ ...SEED, id: "queued1" });
    repo.create({ ...SEED, id: "building1" });
    repo.transition("building1", "building");
    repo.create({ ...SEED, id: "escalated1" });
    repo.transition("escalated1", "building");
    repo.escalate("escalated1", "re-decompose");
    repo.create({ ...SEED, id: "done1" });
    repo.transition("done1", "building");
    repo.transition("done1", "review");
    repo.transition("done1", "done");
    repo.create({ ...SEED, id: "failed1" });
    repo.transition("failed1", "building");
    repo.transition("failed1", "failed");

    // queued/building/escalated are incomplete; done/failed are not. An escalated
    // dispatch is parked work the daemon resumes (rewakes), so it must surface here.
    const incomplete = repo.resumeIncomplete().map((d) => d.id);
    expect(incomplete).toEqual(["escalated1", "building1", "queued1"]);
  });
});
