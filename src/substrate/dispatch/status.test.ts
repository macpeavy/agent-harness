import { describe, expect, it } from "bun:test";
import { renderStatus } from "./status";
import type { Dispatch } from "./schema";

const FIXTURE_DISPATCHES: Dispatch[] = [
  {
    id: "d1",
    issueId: "SHAKE-1",
    title: "Example 1",
    branch: "feature-1",
    spec: "Build something",
    state: "queued",
    route: "builder",
    amendRounds: 0,
    buildCostUsd: 0.005,
    reviewCostUsd: 0.02,
    amendCostUsd: null,
    buildSessionId: null,
    reviewSessionId: null,
    prUrl: null,
    escalated: null,
    surface: null,
    skills: null,
    tier: null,
    sessionBranch: null,
    pendingFindings: null,
    reapedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "d2",
    issueId: "SHAKE-2",
    title: "Example 2",
    branch: "feature-2",
    spec: "Review something",
    state: "building",
    route: null,
    amendRounds: 2,
    buildCostUsd: 0.01,
    reviewCostUsd: 0.05,
    amendCostUsd: 0.005,
    buildSessionId: null,
    reviewSessionId: null,
    prUrl: null,
    escalated: null,
    surface: null,
    skills: null,
    tier: null,
    sessionBranch: null,
    pendingFindings: null,
    reapedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: "d3",
    issueId: "SHAKE-3",
    title: "Example 3",
    branch: "feature-3",
    spec: "Amend cycle",
    state: "done",
    route: "reviewer",
    amendRounds: 3,
    buildCostUsd: 0.02,
    reviewCostUsd: 0.03,
    amendCostUsd: 0.015,
    buildSessionId: null,
    reviewSessionId: null,
    prUrl: null,
    escalated: null,
    surface: null,
    skills: null,
    tier: null,
    sessionBranch: null,
    pendingFindings: null,
    reapedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
] as const;

describe("renderStatus", () => {
  it("renders a couple of dispatches with aligned columns and correct values", () => {
    const output = renderStatus(FIXTURE_DISPATCHES);
    const lines = output.split("\n");
    
    // Should have header + 3 data rows = 4 lines
    expect(lines.length).toBe(4);
    
    // Line 0: header
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("STATE");
    expect(lines[0]).toContain("ROUTE");
    expect(lines[0]).toContain("AMENDS");
    expect(lines[0]).toContain("COST");
    
    // Line 1: d1 data
    expect(lines[1]).toContain("d1");
    expect(lines[1]).toContain("queued");
    expect(lines[1]).toContain("builder");
    expect(lines[1]).toContain("0");
    expect(lines[1]).toContain("$0.0250"); // 0.005 + 0.02 + 0 = 0.025
    
    // Line 2: d2 data - route should be "—" for null
    expect(lines[2]).toContain("d2");
    expect(lines[2]).toContain("building");
    expect(lines[2]).toContain("—");
    expect(lines[2]).toContain("2");
    expect(lines[2]).toContain("$0.0650"); // 0.01 + 0.05 + 0.005 = 0.065
    
    // Line 3: d3 data
    expect(lines[3]).toContain("d3");
    expect(lines[3]).toContain("done");
    expect(lines[3]).toContain("reviewer");
    expect(lines[3]).toContain("3");
    expect(lines[3]).toContain("$0.0650"); // 0.02 + 0.03 + 0.015 = 0.065
  });

  it("handles empty input", () => {
    expect(renderStatus([])).toBe("No dispatches.");
  });

  it("formats cost as $0.0000 when all costs are null", () => {
    const noCosts: Dispatch[] = [
      {
        id: "d-null",
        issueId: "TEST",
        title: "Test",
        branch: "test",
        spec: "test",
        state: "queued",
        route: null,
        amendRounds: 0,
        buildCostUsd: null,
        reviewCostUsd: null,
        amendCostUsd: null,
        buildSessionId: null,
        reviewSessionId: null,
        prUrl: null,
        escalated: null,
        surface: null,
        skills: null,
        tier: null,
        sessionBranch: null,
        pendingFindings: null,
        reapedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ] as const;
    
    expect(renderStatus(noCosts)).toContain("$0.0000");
  });
});
