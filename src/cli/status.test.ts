// Tests for the fleet status renderer
// import.meta.main is not tested (hits real db) — pure renderFleetStatus tested only

import { describe, expect, it } from "bun:test";
import { renderFleetStatus } from "./status";
import type { FeatureStatus } from "../dispatch/plan-dispatch";

const baseStatus: FeatureStatus[] = [
  {
    feature: { id: "feat-a", title: "Feature A", state: "planning" },
    sessions: [],
  },
];

describe("renderFleetStatus", () => {
  it("returns a string containing 'Fleet status' and 'Fleet:' footer", () => {
    const rendered = renderFleetStatus(baseStatus);
    expect(rendered).toContain("Fleet status");
    expect(rendered).toContain("Fleet:");
  });

  it("with one feature/session/chunk renders feature id, session state, chunk id", () => {
    const statuses: FeatureStatus[] = [
      {
        feature: { id: "f1", title: "Title", state: "planning" },
        sessions: [
          {
            session: {
              id: "s1",
              state: "planning",
              branch: null,
              prNumber: null,
              prUrl: null,
              locEstimate: null,
              lastError: null,
            },
            chunks: [
              {
                id: "c1",
                surface: "file.ts",
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
            } as any,
            escalations: [] as any,
          },
        ],
      },
    ];

    const rendered = renderFleetStatus(statuses);
    expect(rendered).toContain('Feature f1 "Title" — planning');
    expect(rendered).toContain('Session s1 [planning]');
    expect(rendered).toContain('c1');
    expect(rendered).toContain('file.ts');
    expect(rendered).toContain('planned');
  });

  it("footer cheap-able fraction aggregates correctly across sessions", () => {
    const statuses: FeatureStatus[] = [
      {
        feature: { id: "f1", title: "Title A", state: "building" },
        sessions: [
          {
            session: {
              id: "s1",
              state: "building",
              branch: null,
              prNumber: null,
              prUrl: null,
              locEstimate: null,
              lastError: null,
            },
            chunks: [],
            readout: {
              total: 4,
              reachedReady: 2,
              escalated: 1,
              failed: 1,
              inFlight: 0,
              cheapAbleFraction: 0.5,
              blendedCostPerReadyUsd: 10.5,
              totalCostUsd: 52.0,
              amendRoundsHistogram: {},
            } as any,
            escalations: [] as any,
          },
        ],
      },
    ];

    const rendered = renderFleetStatus(statuses);
    expect(rendered).toMatch(/Fleet: cheap-able 50\.00%.*total: \$52\.0000/);
  });

  it("renders terminal state counts correctly in readout", () => {
    const statuses: FeatureStatus[] = [
      {
        feature: { id: "f1", title: "Title", state: "review" } as any,
        sessions: [
          {
            session: {
              id: "s1",
              state: "review",
              branch: null,
              prNumber: null,
              prUrl: null,
              locEstimate: 1200,
              lastError: null,
            },
            chunks: [],
            readout: {
              total: 3,
              reachedReady: 0,
              escalated: 1,
              failed: 2,
              inFlight: 0,
              cheapAbleFraction: 0,
              blendedCostPerReadyUsd: 0,
              totalCostUsd: 30.5,
              amendRoundsHistogram: {},
            } as any,
            escalations: [] as any,
          },
        ],
      },
    ];

    const rendered = renderFleetStatus(statuses);
    expect(rendered).toContain('Readout: 0/3 done');
    expect(rendered).toContain('cheap-able 0.0%');
  });

  it("renders PR linkage when present", () => {
    const statuses: FeatureStatus[] = [
      {
        feature: { id: "f1", title: "Title", state: "review" } as any,
        sessions: [
          {
            session: {
              id: "s1",
              state: "review",
              branch: "main",
              prNumber: 42,
              prUrl: "https://github.com/owner/repo/pull/42",
              locEstimate: 1000,
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
            } as any,
            escalations: [] as any,
          },
        ],
      },
    ];

    const rendered = renderFleetStatus(statuses);
    expect(rendered).toContain('Session s1 [review]');
    expect(rendered).toContain('PR #42');
    expect(rendered).toContain('| https://github.com/owner/repo/pull/42');
    expect(rendered).toContain('| ~1000 LOC');
  });

  it("renders dispatch state when linked", () => {
    const statuses: FeatureStatus[] = [
      {
        feature: { id: "f1", title: "Title", state: "building" },
        sessions: [
          {
            session: {
              id: "s1",
              state: "building",
              branch: null,
              prNumber: null,
              prUrl: null,
              locEstimate: null,
              lastError: null,
            },
            chunks: [
              {
                id: "c1",
                surface: "file.ts",
                state: "planned",
                dispatchId: "disp1",
                dispatchState: "queued",
              },
            ],
            readout: {
              total: 1,
              reachedReady: 0,
              escalated: 0,
              failed: 0,
              inFlight: 1,
              cheapAbleFraction: 0,
              blendedCostPerReadyUsd: 0,
              totalCostUsd: 0,
              amendRoundsHistogram: {},
            } as any,
            escalations: [] as any,
          },
        ],
      },
    ];

    const rendered = renderFleetStatus(statuses);
    expect(rendered).toContain('c1');
    expect(rendered).toContain('file.ts');
    expect(rendered).toContain('queued');
  });

  it("renders multiple features", () => {
    const statuses: FeatureStatus[] = [
      {
        feature: { id: "f1", title: "First", state: "planning" },
        sessions: [] as any,
      },
      {
        feature: { id: "f2", title: "Second", state: "building" },
        sessions: [] as any,
      },
    ];

    const rendered = renderFleetStatus(statuses);
    expect(rendered).toContain('Feature f1 "First" — planning');
    expect(rendered).toContain('Feature f2 "Second" — building');
  });

  it("renders empty features array", () => {
    const statuses: FeatureStatus[] = [];
    const rendered = renderFleetStatus(statuses);
    expect(rendered).toContain("Fleet status");
    expect(rendered).toContain("Fleet:");
  });

  it("aggregates costs correctly across multiple sessions", () => {
    const statuses: FeatureStatus[] = [
      {
        feature: { id: "f1", title: "First", state: "building" },
        sessions: [
          {
            session: {
              id: "s1",
              state: "building",
              branch: null,
              prNumber: null,
              prUrl: null,
              locEstimate: null,
              lastError: null,
            },
            chunks: [] as any,
            readout: {
              total: 1,
              reachedReady: 1,
              escalated: 0,
              failed: 0,
              inFlight: 0,
              cheapAbleFraction: 1.0,
              blendedCostPerReadyUsd: 10.0,
              totalCostUsd: 10.0,
              amendRoundsHistogram: {},
            } as any,
            escalations: [] as any,
          },
        ],
      },
    ];

    const rendered = renderFleetStatus(statuses);
    expect(rendered).toMatch(/Fleet: cheap-able 100\.00%.*blended \$\/PR: \$10\.0000.*total: \$10\.0000/);
  });
});
