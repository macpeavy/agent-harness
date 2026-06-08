// Tests for the pure fleet-wide status render function.
// Run: bun test src/cli/fleet-readout.test.ts

import { describe, expect, it } from "bun:test";
import { renderFleetStatus } from "./fleet-readout";
import type { FleetData, DispatchRow, ChunkRow, FeatureRow } from "./fleet-readout";

describe("renderFleetStatus", () => {
  it("returns a sensible message with empty FleetData (no features)", () => {
    const data: FleetData = {
      features: [],
      chunksByFeatureId: new Map(),
      dispatchById: new Map(),
    };
    const output = renderFleetStatus(data);
    expect(output).toContain("Fleet: 0 dispatches");
    expect(output).toContain("cheap-able 0.00");
  });

  it("with one feature + one dispatched chunk: shows feature header, chunk info, cost, PR link", () => {
    const featureRows: FeatureRow[] = [
      { id: "f-001", title: "Add dark mode", state: "building" },
    ];

    const chunkRows: ChunkRow[] = [
      { id: "c-001", surface: "src/components/Button.tsx", dispatchId: "d-001" },
    ];

    const dispatchRows: DispatchRow[] = [
      {
        id: "d-001",
        state: "building",
        route: "cheap",
        amendRounds: 0,
        escalated: null,
        prUrl: "https://github.com/org/repo/pull/123",
        buildCostUsd: 10.5,
        reviewCostUsd: 5.25,
        amendCostUsd: 0,
        tier: "cheap",
      },
    ];

    const data: FleetData = {
      features: featureRows,
      chunksByFeatureId: new Map([["f-001", chunkRows]]),
      dispatchById: new Map(dispatchRows.map((d) => [d.id, d])),
    };

    const output = renderFleetStatus(data);
    expect(output).toContain('=== [building] f-001 "Add dark mode" ===');
    expect(output).toContain("c-001 | src/components/Button.tsx | building");
    expect(output).toContain("$15.7500"); // 10.5 + 5.25 + 0
    expect(output).toContain("https://github.com/org/repo/pull/123");
  });

  it("with null values: shows '—' for route, escalation, PR", () => {
    const featureRows: FeatureRow[] = [
      { id: "f-002", title: "Refactor API", state: "planning" },
    ];

    const chunkRows: ChunkRow[] = [
      { id: "c-002", surface: "src/api/client.ts", dispatchId: "d-002" },
    ];

    const dispatchRows: DispatchRow[] = [
      {
        id: "d-002",
        state: "queued",
        route: null,
        amendRounds: 0,
        escalated: null,
        prUrl: null,
        buildCostUsd: 2.0,
        reviewCostUsd: 1.0,
        amendCostUsd: 3.0,
        tier: null,
      },
    ];

    const data: FleetData = {
      features: featureRows,
      chunksByFeatureId: new Map([["f-002", chunkRows]]),
      dispatchById: new Map(dispatchRows.map((d) => [d.id, d])),
    };

    const output = renderFleetStatus(data);
    expect(output).toContain("c-002 | src/api/client.ts | queued | — | — | 0 | — | — | $6.0000");
  });

  it("with mixed states: each state appears correctly in its row", () => {
    const featureRows: FeatureRow[] = [
      { id: "f-003", title: "Mixed feature", state: "ready" },
    ];

    const chunkRows: ChunkRow[] = [
      { id: "c-003a", surface: "src/foo.ts", dispatchId: "d-003a" },
      { id: "c-003b", surface: "src/bar.ts", dispatchId: "d-003b" },
      { id: "c-003c", surface: "src/baz.ts", dispatchId: "d-003c" },
    ];

    const dispatchRows: DispatchRow[] = [
      {
        id: "d-003a",
        state: "building",
        route: "cheap",
        amendRounds: 0,
        escalated: null,
        prUrl: null,
        buildCostUsd: 1.0,
        reviewCostUsd: 0,
        amendCostUsd: 0,
        tier: "cheap",
      },
      {
        id: "d-003b",
        state: "done",
        route: "cheap",
        amendRounds: 2,
        escalated: null,
        prUrl: "https://github.com/org/repo/pull/456",
        buildCostUsd: 2.0,
        reviewCostUsd: 1.0,
        amendCostUsd: 3.0,
        tier: "cheap",
      },
      {
        id: "d-003c",
        state: "escalated",
        route: "strong",
        amendRounds: 1,
        escalated: "tier-promote",
        prUrl: null,
        buildCostUsd: 5.0,
        reviewCostUsd: 3.0,
        amendCostUsd: 8.0,
        tier: "strong",
      },
    ];

    const data: FleetData = {
      features: featureRows,
      chunksByFeatureId: new Map([["f-003", chunkRows]]),
      dispatchById: new Map(dispatchRows.map((d) => [d.id, d])),
    };

    const output = renderFleetStatus(data);
    expect(output).toContain("c-003a | src/foo.ts | building");
    expect(output).toContain("c-003b | src/bar.ts | done");
    expect(output).toContain("c-003c | src/baz.ts | escalated");
    expect(output).toContain("tier-promote");
  });

  it("with features having no dispatched chunks: shows '(no dispatches yet)'", () => {
    const featureRows: FeatureRow[] = [
      { id: "f-999", title: "Empty feature", state: "planning" },
    ];

    const data: FleetData = {
      features: featureRows,
      chunksByFeatureId: new Map([["f-999", []]]),
      dispatchById: new Map(),
    };

    const output = renderFleetStatus(data);
    expect(output).toContain('=== [planning] f-999 "Empty feature" ===');
    expect(output).toContain("(no dispatches yet)");
    // No per-dispatch rows should exist (no lines containing both chunk id and surface)
    const lines = output.split("\n");
    const hasDispatchRow = lines.some((line) => line.includes(" | ") && !line.includes("=== [") && !line.includes("Fleet:"));
    expect(hasDispatchRow).toBe(false);
  });

  it("footer line contains cheap-able fraction and blended cost-per-PR", () => {
    const featureRows: FeatureRow[] = [
      { id: "f-004", title: "Cost test", state: "done" },
    ];

    const chunkRows: ChunkRow[] = [
      { id: "c-004", surface: "src/test.ts", dispatchId: "d-004" },
    ];

    const dispatchRows: DispatchRow[] = [
      {
        id: "d-004",
        state: "done",
        route: "cheap",
        amendRounds: 0,
        escalated: null,
        prUrl: "https://github.com/org/repo/pull/789",
        buildCostUsd: 10.0,
        reviewCostUsd: 5.0,
        amendCostUsd: 2.5,
        tier: "cheap",
      },
    ];

    const data: FleetData = {
      features: featureRows,
      chunksByFeatureId: new Map([["f-004", chunkRows]]),
      dispatchById: new Map(dispatchRows.map((d) => [d.id, d])),
    };

    const output = renderFleetStatus(data);
    expect(output).toMatch(/Fleet: 1 dispatches \| cheap-able 1\.00 \| \$17\.5000 blended\/PR \| \$17\.5000 total/);
  });

  it("newest features appear first (sorted by id descending)", () => {
    const featureRows: FeatureRow[] = [
      { id: "f-001", title: "Older", state: "done" },
      { id: "f-999", title: "Newer", state: "planning" },
    ];

    const data: FleetData = {
      features: featureRows,
      chunksByFeatureId: new Map(),
      dispatchById: new Map(),
    };

    const output = renderFleetStatus(data);
    // Feature "f-999" should come before "f-001" when sorted descending
    const lines = output.split("\n");
    const newerIndex = lines.findIndex((line) => line.includes('f-999'));
    const olderIndex = lines.findIndex((line) => line.includes('f-001'));
    expect(newerIndex).toBeLessThan(olderIndex);
  });
});
