// Tests for the fleet-status CLI and its renderer.
// Co-located with the module; run with bun test src/cli/status.test.ts

import { describe, expect, it } from "bun:test";
import { renderFleetStatus } from "./status";

describe("status CLI renderer", () => {
  it("empty fleet renders header and footer", () => {
    const result = renderFleetStatus([]);
    expect(result).toContain("Fleet status");
    expect(result).toContain("Fleet: cheap-able 0.00%");
    expect(result).toContain("blended $/PR: $0.00");
    expect(result).toContain("total: $0.00");
  });

  it("single feature/session/chunk renders IDs", () => {
    const statuses = [
      {
        feature: { id: "feat-001", title: "Add login", state: "planning" },
        sessions: [
          {
            session: {
              id: "sess-001",
              state: "planning",
              branch: "feat-001/sess-001",
              prNumber: null,
              prUrl: null,
              locEstimate: 500,
              lastError: null,
            },
            chunks: [
              {
                id: "chunk-001",
                surface: "src/auth.ts",
                state: "planned",
                dispatchId: null,
                dispatchState: null,
              },
            ],
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
      },
    ];

    const result = renderFleetStatus(statuses);
    expect(result).toContain("Feature feat-001 \"Add login\"");
    expect(result).toContain("Session sess-001 [planning]");
    expect(result).toContain("chunk-001  src/auth.ts  planned");
  });

  it("footer aggregates cheap-able fraction across sessions", () => {
    // Two sessions: first has 10 chunks with all done, second has 10 chunks with 5 done
    const statuses = [
      {
        feature: { id: "feat-002", title: "Two sessions", state: "building" },
        sessions: [
          {
            session: {
              id: "sess-002",
              state: "building",
              branch: null,
              prNumber: 42,
              prUrl: "https://github.com/owner/repo/pull/42",
              locEstimate: 1000,
              lastError: null,
            },
            chunks: Array.from({ length: 10 }, (_, i) => ({
              id: `chunk-${i}`,
              surface: `src/file${i}.ts`,
              state: "done",
              dispatchId: null,
              dispatchState: null,
            })),
            readout: {
              total: 10,
              reachedReady: 10,
              escalated: 0,
              failed: 0,
              inFlight: 0,
              cheapAbleFraction: 1,
              blendedCostPerReadyUsd: 100,
              totalCostUsd: 1000,
              amendRoundsHistogram: {},
            },
            escalations: [],
          },
          {
            session: {
              id: "sess-003",
              state: "review",
              branch: null,
              prNumber: 43,
              prUrl: "https://github.com/owner/repo/pull/43",
              locEstimate: 800,
              lastError: null,
            },
            chunks: Array.from({ length: 10 }, (_, i) => ({
              id: `chunk-${i + 10}`,
              surface: `src/file${i + 10}.ts`,
              state: i < 5 ? "done" : "planned",
              dispatchId: null,
              dispatchState: null,
            })),
            readout: {
              total: 10,
              reachedReady: 5,
              escalated: 0,
              failed: 0,
              inFlight: 5,
              cheapAbleFraction: 0.5,
              blendedCostPerReadyUsd: 150,
              totalCostUsd: 750,
              amendRoundsHistogram: {},
            },
            escalations: [],
          },
        ],
      },
    ];

    const result = renderFleetStatus(statuses);
    // Total: 20 chunks (15 done across both sessions, 5 planned/inFlight)
    // Terminal count: 15 done
    // Cheap-able fraction: 15/15 = 100%
    expect(result).toContain("Fleet: cheap-able");
    // Fleet blended cost per done PR: (1000 + 750) / 15 = 116.67
    expect(result).toMatch(/blended \$\/PR: \$116\.67/);
  });

  it("renders multiple features", () => {
    const statuses = [
      {
        feature: { id: "feat-a", title: "Feature A", state: "building" },
        sessions: [
          {
            session: {
              id: "sess-a",
              state: "building",
              branch: null,
              prNumber: null,
              prUrl: null,
              locEstimate: 500,
              lastError: null,
            },
            chunks: [
              {
                id: "chunk-a1",
                surface: "src/a1.ts",
                state: "planned",
                dispatchId: null,
                dispatchState: null,
              },
            ],
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
      },
      {
        feature: { id: "feat-b", title: "Feature B", state: "planning" },
        sessions: [
          {
            session: {
              id: "sess-b",
              state: "planning",
              branch: null,
              prNumber: null,
              prUrl: null,
              locEstimate: 300,
              lastError: null,
            },
            chunks: [
              {
                id: "chunk-b1",
                surface: "src/b1.ts",
                state: "planned",
                dispatchId: null,
                dispatchState: null,
              },
            ],
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
      },
    ];

    const result = renderFleetStatus(statuses);
    expect(result).toContain("Feature feat-a \"Feature A\"");
    expect(result).toContain("Feature feat-b \"Feature B\"");
  });
});
