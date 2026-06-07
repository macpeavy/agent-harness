import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DispatchRegistry,
  isTerminal,
  nonTerminalStates,
  TRANSITIONS,
  type CreateDispatch,
} from "./registry";

let dir: string;
let registry: DispatchRegistry;

const SEED: CreateDispatch = {
  id: "d1",
  issueId: "AGENT-18",
  title: "Dispatch registry",
  branch: "agent-18-dispatch-registry",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-registry-"));
  registry = new DispatchRegistry(join(dir, "dispatches.db"));
});

afterEach(() => {
  registry.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the transition graph", () => {
  it("derives the terminal set from the graph, not a hardcoded list", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("escalated")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("amending")).toBe(false);
  });

  it("derives non-terminal states from the graph", () => {
    expect(nonTerminalStates().sort()).toEqual(["amending", "building", "queued", "review"]);
  });

  it("every transition target is itself a known state (no dangling edges)", () => {
    const states = new Set(Object.keys(TRANSITIONS));
    for (const targets of Object.values(TRANSITIONS))
      for (const t of targets) expect(states.has(t)).toBe(true);
  });
});

describe("create / get / list", () => {
  it("creates a dispatch in state 'queued'", () => {
    registry.create(SEED);
    const d = registry.get("d1");
    expect(d?.state).toBe("queued");
    expect(d?.issueId).toBe("AGENT-18");
    expect(d?.amendRounds).toBe(0);
  });

  it("returns null for an unknown id", () => {
    expect(registry.get("nope")).toBeNull();
  });

  it("lists newest first and filters by state", () => {
    registry.create({ ...SEED, id: "d1" });
    registry.create({ ...SEED, id: "d2" });
    registry.transition("d2", "building");

    const all = registry.list();
    expect(all.map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(registry.list({ state: "building" }).map((d) => d.id)).toEqual(["d2"]);
    expect(registry.list({ state: "queued" }).map((d) => d.id)).toEqual(["d1"]);
  });
});

describe("transition", () => {
  it("walks a full valid path queued → building → review → amending → review → done", () => {
    registry.create(SEED);
    for (const to of ["building", "review", "amending", "review", "done"] as const)
      registry.transition("d1", to);
    expect(registry.get("d1")?.state).toBe("done");
  });

  it("rejects an illegal transition and leaves state unchanged", () => {
    registry.create(SEED);
    expect(() => registry.transition("d1", "done")).toThrow("illegal queued → done");
    expect(registry.get("d1")?.state).toBe("queued");
  });

  it("rejects a transition out of a terminal state", () => {
    registry.create(SEED);
    registry.transition("d1", "building");
    registry.transition("d1", "failed");
    expect(() => registry.transition("d1", "review")).toThrow("illegal failed → review");
  });

  it("throws on a transition for an unknown dispatch", () => {
    expect(() => registry.transition("ghost", "building")).toThrow("no dispatch ghost");
  });
});

describe("escalate", () => {
  it("moves to 'escalated' and records the kind atomically", () => {
    registry.create(SEED);
    registry.transition("d1", "building");
    registry.transition("d1", "review");
    registry.transition("d1", "amending");
    registry.escalate("d1", "re-decompose");

    const d = registry.get("d1");
    expect(d?.state).toBe("escalated");
    expect(d?.escalated).toBe("re-decompose");
  });

  it("rejects escalation from a state with no escalated edge", () => {
    registry.create(SEED);
    expect(() => registry.escalate("d1", "attended")).toThrow("illegal queued → escalated");
  });
});

describe("linking", () => {
  it("links both session ids in one atomic write", () => {
    registry.create(SEED);
    registry.setSessions("d1", { buildSessionId: "sess-build", reviewSessionId: "sess-review" });
    const d = registry.get("d1");
    expect(d?.buildSessionId).toBe("sess-build");
    expect(d?.reviewSessionId).toBe("sess-review");
  });

  it("links a single session id without disturbing the other", () => {
    registry.create(SEED);
    registry.setSessions("d1", { buildSessionId: "sess-build" });
    expect(registry.get("d1")?.reviewSessionId).toBeNull();
    registry.setSessions("d1", { reviewSessionId: "sess-review" });
    expect(registry.get("d1")?.buildSessionId).toBe("sess-build");
  });

  it("links a PR url", () => {
    registry.create(SEED);
    registry.setPr("d1", "https://github.com/macpeavy/agent-harness/pull/41");
    expect(registry.get("d1")?.prUrl).toContain("/pull/41");
  });

  it("throws when linking onto an unknown dispatch", () => {
    expect(() => registry.setPr("ghost", "url")).toThrow("no dispatch ghost");
  });
});

describe("the instrument columns", () => {
  it("records the route", () => {
    registry.create({ ...SEED, route: "builder" });
    expect(registry.get("d1")?.route).toBe("builder");
    registry.setRoute("d1", "builder-alt");
    expect(registry.get("d1")?.route).toBe("builder-alt");
  });

  it("counts amend rounds", () => {
    registry.create(SEED);
    registry.incrementAmendRound("d1");
    registry.incrementAmendRound("d1");
    expect(registry.get("d1")?.amendRounds).toBe(2);
  });

  it("splits cost per leg, accumulating amend cost across rounds", () => {
    registry.create(SEED);
    registry.setCost("d1", "build", 0.004);
    registry.setCost("d1", "review", 0.074);
    registry.setCost("d1", "amend", 0.005);
    registry.setCost("d1", "amend", 0.006);

    const d = registry.get("d1");
    expect(d?.buildCostUsd).toBeCloseTo(0.004, 6);
    expect(d?.reviewCostUsd).toBeCloseTo(0.074, 6);
    expect(d?.amendCostUsd).toBeCloseTo(0.011, 6);
  });

  it("makes the instrument fields queryable for the cheap-able-fraction readout", () => {
    registry.create({ ...SEED, id: "cheap", route: "builder" });
    registry.create({ ...SEED, id: "promoted", route: "builder-alt" });
    registry.transition("promoted", "building");
    registry.transition("promoted", "review");
    registry.transition("promoted", "amending");
    registry.incrementAmendRound("promoted");
    registry.escalate("promoted", "tier-promote");

    const escalated = registry.list({ state: "escalated" });
    expect(escalated.map((d) => d.id)).toEqual(["promoted"]);
    expect(escalated[0]?.escalated).toBe("tier-promote");
    expect(escalated[0]?.amendRounds).toBe(1);
  });
});

describe("resumeIncomplete", () => {
  it("returns only non-terminal dispatches, newest first", () => {
    registry.create({ ...SEED, id: "queued1" });
    registry.create({ ...SEED, id: "building1" });
    registry.transition("building1", "building");
    registry.create({ ...SEED, id: "done1" });
    registry.transition("done1", "building");
    registry.transition("done1", "review");
    registry.transition("done1", "done");
    registry.create({ ...SEED, id: "failed1" });
    registry.transition("failed1", "building");
    registry.transition("failed1", "failed");

    const incomplete = registry.resumeIncomplete().map((d) => d.id);
    expect(incomplete).toEqual(["building1", "queued1"]);
  });
});
