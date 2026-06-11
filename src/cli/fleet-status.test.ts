import { describe, expect, it } from "bun:test";
import { renderDrivers, renderFleet, type ChiefCostByFeature } from "./fleet-status";
import type { FeatureStatus, SessionStatus } from "../dispatch/plan-dispatch";

const ZERO_COST: FeatureStatus["cost"] = { buildUsd: 0, reviewUsd: 0, amendUsd: 0, window: { start: 0, end: 100 } };
const WIDTH = 34;

function session(over: Partial<SessionStatus["session"]> = {}): SessionStatus {
  return {
    session: {
      id: "S1",
      state: "building",
      branch: null,
      prNumber: null,
      prUrl: null,
      locEstimate: null,
      lastError: null,
      budgetExceededUsd: null,
      ...over,
    },
    chunks: [],
    readout: {
      total: 0,
      reachedReady: 0,
      escalated: 0,
      failed: 0,
      inFlight: 0,
      cheapAbleFraction: 0,
      blendedCostPerReadyUsd: 0,
      totalCostUsd: 0,
      amendRoundsHistogram: {},
    },
    escalations: [],
  };
}

function feature(over: {
  id?: string;
  state?: FeatureStatus["feature"]["state"];
  budgetUsd?: number | null;
  cost?: FeatureStatus["cost"];
  sessions?: SessionStatus[];
}): FeatureStatus {
  return {
    feature: { id: over.id ?? "feat-1", title: "T", state: over.state ?? "building", budgetUsd: over.budgetUsd ?? null },
    cost: over.cost ?? ZERO_COST,
    sessions: over.sessions ?? [],
  };
}

describe("renderFleet (compact card layout)", () => {
  it("renders '(no features)' for an empty fleet", () => {
    expect(renderFleet([])).toBe("fleet · (no features)");
  });

  it("headers with the grand total (chief + legs across all features)", () => {
    const f = feature({ cost: { buildUsd: 0.4, reviewUsd: 0.06, amendUsd: 0, window: { start: 0, end: 1 } } });
    const chief: ChiefCostByFeature = new Map([["feat-1", 0.05]]);
    const out = renderFleet([f], undefined, chief);
    expect(out).toContain("fleet · $0.51 total"); // 0.40 + 0.06 + 0.05 chief
  });

  it("renders a card: bullet id, lead-session state/PR/LOC, and a chunk tally + total", () => {
    const f = feature({
      id: "fleet-status-budget-v2",
      cost: { buildUsd: 0.47, reviewUsd: 0.06, amendUsd: 0, window: { start: 0, end: 1 } },
      sessions: [session({ state: "review", prNumber: 133, locEstimate: 80, })],
    });
    // give the session a done chunk
    f.sessions[0]!.readout.reachedReady = 1;
    const out = renderFleet([f], undefined, new Map([["feat-1", 0]]));
    expect(out).toContain("● fleet-status-budget-v2");
    // Owner language (AGENT-52): `review` reads as awaiting the OWNER, not the reviewer.
    expect(out).toContain("awaiting your review · PR #133");
    expect(out).toContain("✓1 ✗0 ⚠0 · $0.53");
  });

  it("highlights a BUDGET-parked feature with the alert + the decision line", () => {
    const f = feature({
      id: "big-feature",
      budgetUsd: 10,
      sessions: [session({ state: "needs-attention", budgetExceededUsd: 12.4 })],
    });
    const out = renderFleet([f]);
    expect(out).toContain("⚠ BUDGET $12.40/$10.00");
    expect(out).toContain("raise / ship / abandon");
  });

  it("collapses abandoned features to a count — no card for them", () => {
    const out = renderFleet([
      feature({ id: "active-one", sessions: [session()] }),
      feature({ id: "dead-one", state: "abandoned", sessions: [session({ state: "abandoned" })] }),
      feature({ id: "dead-two", state: "abandoned" }),
    ]);
    expect(out).toContain("● active-one");
    expect(out).not.toContain("● dead-one");
    expect(out).toContain("…2 abandoned (hidden)");
  });

  it("shows the time so the watch pane reads as live", () => {
    const out = renderFleet([feature({ sessions: [session()] })], "2026-06-09T17:54:03.000Z");
    expect(out).toContain("updated 17:54:03");
  });

  it("no line exceeds the pane width (fits the narrow column)", () => {
    const f = feature({
      id: "a-really-long-feature-identifier-that-would-overflow-the-narrow-pane",
      budgetUsd: 1234.5,
      sessions: [session({ state: "needs-attention", prNumber: 99999, locEstimate: 4321, budgetExceededUsd: 9999.99 })],
    });
    for (const line of renderFleet([f]).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(WIDTH);
    }
  });
});

describe("driver liveness in the fleet render (AGENT-44)", () => {
  const fresh = { driver: "daemon", pid: 1, ageMs: 4_000, stale: false };
  const dead = { driver: "session-loop", pid: 2, ageMs: 240_000, stale: true };

  it("renderDrivers shows age per expected driver, ⚠ on stale, — when never seen", () => {
    expect(renderDrivers([fresh, dead])).toBe("drv daemon 4s · session-loop ⚠4m");
    expect(renderDrivers([fresh])).toBe("drv daemon 4s · session-loop —");
    expect(renderDrivers([])).toBe("drv daemon — · session-loop —");
  });

  it("a stale driver puts a DRIVER DOWN banner above the cards", () => {
    const out = renderFleet([feature({ sessions: [session()] })], undefined, new Map(), [fresh, dead]);
    expect(out).toContain("session-loop ⚠4m");
    expect(out).toContain("DRIVER DOWN?");
  });

  it("healthy drivers render the drv line without the banner", () => {
    const out = renderFleet([feature({ sessions: [session()] })], undefined, new Map(), [fresh]);
    expect(out).toContain("drv daemon 4s");
    expect(out).not.toContain("DRIVER DOWN?");
  });

  it("no heartbeat rows at all (pre-first-launch) renders no drv line", () => {
    const out = renderFleet([feature({ sessions: [session()] })]);
    expect(out).not.toContain("drv ");
  });
});
