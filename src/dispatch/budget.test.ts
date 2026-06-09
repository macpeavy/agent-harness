import { describe, expect, it } from "bun:test";
import { DEFAULT_BUDGET } from "../budget-config";
import { budgetFromEstimate, estimateFeatureCost, isOverBudget, legAveragesFrom, type LegAverages } from "./budget";

const AVERAGES: LegAverages = { build: 0.1, review: 0.4, amend: 0.2 };

describe("estimateFeatureCost", () => {
  it("forecasts chunkCount × (build + review + expectedAmend×amend) + decomposition", () => {
    const cfg = { ...DEFAULT_BUDGET, expectedAmendRounds: 1, decompositionSeedUsd: 0.5 };
    const est = estimateFeatureCost(4, AVERAGES, cfg);
    // perChunk = 0.1 + 0.4 + 1×0.2 = 0.7; ×4 = 2.8; + 0.5 decomposition = 3.3
    expect(est.perChunkUsd).toBeCloseTo(0.7, 6);
    expect(est.estimateUsd).toBeCloseTo(3.3, 6);
    expect(est.chunkCount).toBe(4);
    expect(est.decompositionUsd).toBe(0.5);
  });

  it("honors expectedAmendRounds (0 → no amend cost in the forecast)", () => {
    const cfg = { ...DEFAULT_BUDGET, expectedAmendRounds: 0, decompositionSeedUsd: 0 };
    const est = estimateFeatureCost(2, AVERAGES, cfg);
    expect(est.perChunkUsd).toBeCloseTo(0.5, 6); // build + review only
    expect(est.estimateUsd).toBeCloseTo(1.0, 6);
  });

  it("a single build-direct chunk is just one chunk + decomposition seed", () => {
    const est = estimateFeatureCost(1, AVERAGES, { ...DEFAULT_BUDGET, expectedAmendRounds: 1, decompositionSeedUsd: 0.6 });
    expect(est.estimateUsd).toBeCloseTo(0.7 + 0.6, 6);
  });
});

describe("budgetFromEstimate", () => {
  it("applies the headroom factor", () => {
    expect(budgetFromEstimate(2.0, { ...DEFAULT_BUDGET, headroom: 1.5 })).toBeCloseTo(3.0, 6);
  });
});

describe("isOverBudget", () => {
  it("trips only when the total exceeds a set budget", () => {
    expect(isOverBudget(3.01, 3.0)).toBe(true);
    expect(isOverBudget(3.0, 3.0)).toBe(false); // exactly at budget is not over
    expect(isOverBudget(2.5, 3.0)).toBe(false);
  });

  it("never trips when no budget is set (opt-in guard)", () => {
    expect(isOverBudget(9999, null)).toBe(false);
  });
});

describe("legAveragesFrom", () => {
  const seed: LegAverages = { build: 0.15, review: 0.4, amend: 0.15 };

  it("averages the recorded leg costs over finished dispatches", () => {
    const rows = [
      { buildCostUsd: 0.1, reviewCostUsd: 0.3, amendCostUsd: 0.2 },
      { buildCostUsd: 0.2, reviewCostUsd: 0.5, amendCostUsd: null },
    ];
    const a = legAveragesFrom(rows, seed);
    expect(a.build).toBeCloseTo(0.15, 6); // (0.1 + 0.2)/2
    expect(a.review).toBeCloseTo(0.4, 6); // (0.3 + 0.5)/2
    expect(a.amend).toBeCloseTo(0.2, 6); // only the one non-null
  });

  it("falls back to the seed for a leg with no history (cold start)", () => {
    expect(legAveragesFrom([], seed)).toEqual(seed);
    const noAmend = [{ buildCostUsd: 0.1, reviewCostUsd: 0.3, amendCostUsd: null }];
    expect(legAveragesFrom(noAmend, seed).amend).toBe(seed.amend); // amend falls back
  });

  it("ignores zero/negative leg costs (treats them as no data)", () => {
    const rows = [{ buildCostUsd: 0, reviewCostUsd: 0.3, amendCostUsd: 0.2 }];
    expect(legAveragesFrom(rows, seed).build).toBe(seed.build); // 0 → no data → seed
  });
});
