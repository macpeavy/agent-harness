import { describe, expect, it } from "bun:test";
import { renderFleet } from "./fleet-status";
import type { FeatureStatus } from "../dispatch/plan-dispatch";

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
      feature: { id: "feat-1", title: "My Feature", state: "building" },
      sessions: [],
    };
    const output = renderFleet([mockStatus]);
    expect(output).toContain("[building] feat-1");
    expect(output).toContain("My Feature");
  });

  it("contains session line with id, state, PR number, and LOC", () => {
    const mockStatus: FeatureStatus = {
      feature: { id: "feat-1", title: "My Feature", state: "building" },
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
      feature: { id: "feat-1", title: "My Feature", state: "building" },
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
      feature: { id: "feat-1", title: "My Feature", state: "building" },
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
      feature: { id: "feat-1", title: "My Feature", state: "building" },
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
      },
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
    const output = renderFleet([mockStatus]);
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
      feature: { id: "feat-1", title: "My Feature", state: "building" },
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
});
