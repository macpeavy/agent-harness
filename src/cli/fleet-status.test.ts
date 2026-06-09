import { describe, expect, it } from "bun:test";
import { renderFleet, type ChiefCostByFeature } from "./fleet-status";
import type { FeatureStatus } from "../dispatch/plan-dispatch";

const ZERO_COST: FeatureStatus["cost"] = { buildUsd: 0, reviewUsd: 0, amendUsd: 0, window: { start: 0, end: 100 } };

describe("renderFleet", () => {
  it("contains '(no features)' for an empty fleet", () => {
    const output = renderFleet([]);
    expect(output).toContain("(no features)");
  });

  it("starts with 'Fleet status — '", () => {
    const output = renderFleet([]);
    expect(output).toMatch(/^Fleet status — /);
  });

  it("contains feature line with state, id, and title", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: null },
      cost: ZERO_COST,
      sessions: [],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("[building] feat-1");
    expect(output).toContain("My Feature");
  });

  it("contains session line with id, state, PR number, and LOC", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: null },
      cost: ZERO_COST,
      sessions: [
        {
          session: {
            id: "sess-1",
            state: "building",
            branch: null,
            prNumber: 42,
            prUrl: null,
            locEstimate: 800,
            lastError: null,
            budgetExceededUsd: null,
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
        },
      ],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("sess-1 [building]");
    expect(output).toContain("PR #42");
    expect(output).toContain("~800 LOC");
  });

  it("contains chunk line with id, surface, state, and dispatch state", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: null },
      cost: ZERO_COST,
      sessions: [
        {
          session: {
            id: "sess-1",
            state: "building",
            branch: null,
            prNumber: 42,
            prUrl: null,
            locEstimate: 800,
            lastError: null,
            budgetExceededUsd: null,
          },
          chunks: [
            {
              id: "chunk-1",
              surface: "src/foo.ts",
              state: "done",
              dispatchId: "chunk-1",
              dispatchState: "done",
            },
          ],
          readout: {
            total: 1,
            reachedReady: 1,
            escalated: 0,
            failed: 0,
            inFlight: 0,
            cheapAbleFraction: 1,
            blendedCostPerReadyUsd: 0.002,
            totalCostUsd: 0.002,
            amendRoundsHistogram: {},
          },
          escalations: [],
        },
      ],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("chunk-1");
    expect(output).toContain("src/foo.ts");
  });

  it("contains readout line with done/esc/fail/in-flight counts and cheap-able", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: null },
      cost: ZERO_COST,
      sessions: [
        {
          session: {
            id: "sess-1",
            state: "building",
            branch: null,
            prNumber: 42,
            prUrl: null,
            locEstimate: 800,
            lastError: null,
            budgetExceededUsd: null,
          },
          chunks: [
            {
              id: "chunk-1",
              surface: "src/foo.ts",
              state: "done",
              dispatchId: "chunk-1",
              dispatchState: "done",
            },
          ],
          readout: {
            total: 1,
            reachedReady: 1,
            escalated: 0,
            failed: 0,
            inFlight: 0,
            cheapAbleFraction: 1,
            blendedCostPerReadyUsd: 0.002,
            totalCostUsd: 0.002,
            amendRoundsHistogram: {},
          },
          escalations: [],
        },
      ],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("done 1 / esc 0 / fail 0 / in-flight 0");
    expect(output).toContain("cheap-able 1.00");
  });

  it("contains footer with features, sessions, chunks counts", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: null },
      cost: ZERO_COST,
      sessions: [
        {
          session: {
            id: "sess-1",
            state: "building",
            branch: null,
            prNumber: 42,
            prUrl: null,
            locEstimate: 800,
            lastError: null,
            budgetExceededUsd: null,
          },
          chunks: [
            {
              id: "chunk-1",
              surface: "src/foo.ts",
              state: "done",
              dispatchId: "chunk-1",
              dispatchState: "done",
            },
          ],
          readout: {
            total: 1,
            reachedReady: 1,
            escalated: 0,
            failed: 0,
            inFlight: 0,
            cheapAbleFraction: 1,
            blendedCostPerReadyUsd: 0.002,
            totalCostUsd: 0.002,
            amendRoundsHistogram: {},
          },
          escalations: [],
        },
      ],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("Features: 1  Sessions: 1  Chunks: 1");
  });

  it("no line exceeds 80 characters", () => {
    const mockStatus: FeatureStatus = {
      feature: {
        id: "feat-1",
        title: "This is a very long feature title that should be truncated",
        state: "building",
        budgetUsd: 10.5,
      },
      cost: { buildUsd: 1.2345, reviewUsd: 6.789, amendUsd: 0.5, window: { start: 0, end: 100 } },
      sessions: [
        {
          session: {
            id: "sess-1-with-a-very-long-name-that-should-be-truncated",
            state: "building",
            branch: null,
            prNumber: 42,
            prUrl: null,
            locEstimate: 800,
            lastError: null,
            budgetExceededUsd: null,
          },
          chunks: [
            {
              id: "chunk-1-with-a-very-long-name",
              surface: "src/very/deep/nested/long/path/foo.ts",
              state: "done",
              dispatchId: "chunk-1",
              dispatchState: "done",
            },
          ],
          readout: {
            total: 1,
            reachedReady: 1,
            escalated: 0,
            failed: 0,
            inFlight: 0,
            cheapAbleFraction: 1,
            blendedCostPerReadyUsd: 0.002,
            totalCostUsd: 0.002,
            amendRoundsHistogram: {},
          },
          escalations: [],
        },
      ],
    };
    // Pass a chief cost too, so the cost line is rendered at its widest (chief present, not n/a).
    const chiefCost: ChiefCostByFeature = new Map([["feat-1", 12.3456]]);
    const output = renderFleet([mockStatus], undefined, chiefCost);
    const lines = output.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("uses pinned timestamp when provided", () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const output = renderFleet([], timestamp);
    expect(output).toContain(timestamp);
  });

  it("omits PR and LOC fields when null", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: null },
      cost: ZERO_COST,
      sessions: [
        {
          session: {
            id: "sess-1",
            state: "building",
            branch: null,
            prNumber: null,
            prUrl: null,
            locEstimate: null,
            lastError: null,
            budgetExceededUsd: null,
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
        },
      ],
    };
    const output = renderFleet([mockStatus]);
    expect(output).not.toContain("PR #");
    expect(output).not.toContain("LOC");
  });

  describe("cost line (ADR 0026 — counting the chief)", () => {
    const feature = (cost: FeatureStatus["cost"]): FeatureStatus => ({
      feature: { id: "feat-1", title: "F", state: "building", budgetUsd: null },
      cost,
      sessions: [],
    });

    it("renders the TOTAL as chief + legs, and breaks out per-leg spend", () => {
      const status = feature({ buildUsd: 0.01, reviewUsd: 0.03, amendUsd: 0.005, window: { start: 0, end: 100 } });
      const chiefCost: ChiefCostByFeature = new Map([["feat-1", 0.5]]);
      const output = renderFleet([status], undefined, chiefCost);
      // TOTAL = chief 0.5 + legs (0.01+0.03+0.005=0.045) = 0.545
      expect(output).toContain("cost: TOTAL $0.5450  (chief $0.5000 + legs $0.0450)");
      expect(output).toContain("legs: build $0.0100 / review $0.0300 / amend $0.0050");
      // footer grand total carries the chief separately
      expect(output).toContain("Total $0.5450  (chief $0.5000 + legs $0.0450)");
    });

    it("shows chief n/a (not $0) when the ledger can't be measured", () => {
      const status = feature({ buildUsd: 0.02, reviewUsd: 0, amendUsd: 0, window: { start: 0, end: 100 } });
      const output = renderFleet([status]); // no chiefCost map → unmeasurable
      expect(output).toContain("cost: TOTAL $0.0200  (chief n/a + legs $0.0200)");
    });

    it("treats an explicit null chief as n/a but a 0 chief as measured $0", () => {
      const status = feature({ buildUsd: 0, reviewUsd: 0, amendUsd: 0, window: { start: 0, end: 100 } });
      expect(renderFleet([status], undefined, new Map([["feat-1", null]]))).toContain("chief n/a");
      expect(renderFleet([status], undefined, new Map([["feat-1", 0]]))).toContain("chief $0.0000");
    });
  });

  it("shows budget on feature line when budgetUsd is set", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: 1.5 },
      cost: ZERO_COST,
      sessions: [],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("— budget $1.5000");
  });

  it("marks budget-parked session", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building", budgetUsd: 5.0 },
      cost: ZERO_COST,
      sessions: [
        {
          session: {
            id: "sess-1",
            state: "building",
            branch: null,
            prNumber: 42,
            prUrl: null,
            locEstimate: 800,
            lastError: null,
            budgetExceededUsd: 2.0,
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
        },
      ],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("BUDGET-parked");
    expect(output).toContain("spent $2.0000");
    expect(output).toContain("budget $5.0000");
    expect(output).toContain("raise / ship-partial / abandon");
  });
});
