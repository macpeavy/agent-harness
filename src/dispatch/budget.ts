// The budget estimator + guard (ADR 0026 decision 2) — pure cost arithmetic, no I/O. Two layers
// build on this: the PRE-FLIGHT estimate shown at the decomposition gate, and the RUNTIME breach
// check that parks (never hard-kills) a feature over its budget.
//
// The estimate is a FORECAST (decision-support at the gate), not recorded spend — it's grounded
// in the REAL historical per-leg averages the instrument records (ADR 0026 decision 1), with the
// config seed averages as the cold-start fallback. Recorded cost stays the real ledger numbers.

import type { BudgetConfig } from "../budget-config";

/** Average $/leg, the inputs to a feature estimate — real historical averages when available,
 *  the config seeds at cold start. */
export interface LegAverages {
  build: number;
  review: number;
  amend: number;
}

/** A feature's forecast, broken out so the chief can show "$X to build" with its parts. */
export interface FeatureEstimate {
  chunkCount: number;
  /** Per-chunk forecast: build + review + expectedAmendRounds × amend. */
  perChunkUsd: number;
  /** The chief's one-time decomposition cost (the seed; ~0 conceptually for a 1-chunk direct). */
  decompositionUsd: number;
  /** chunkCount × perChunkUsd + decompositionUsd — the headline number. */
  estimateUsd: number;
  /** The averages used (so the chief can say whether they're real history or seeds). */
  averages: LegAverages;
}

/**
 * Forecast a feature's build cost: each chunk costs one build + one review + the expected amend
 * rounds, plus the chief's one-time decomposition. Pure — the caller supplies the chunk count and
 * the averages (real or seed). Never the recorded cost; a gate-time forecast only.
 */
export function estimateFeatureCost(chunkCount: number, averages: LegAverages, cfg: BudgetConfig): FeatureEstimate {
  const perChunkUsd = averages.build + averages.review + cfg.expectedAmendRounds * averages.amend;
  const decompositionUsd = cfg.decompositionSeedUsd;
  return {
    chunkCount,
    perChunkUsd,
    decompositionUsd,
    estimateUsd: chunkCount * perChunkUsd + decompositionUsd,
    averages,
  };
}

/** The budget for a feature: its estimate × the headroom factor (ADR 0026 — headroom absorbs
 *  normal variance so the guard trips on a real overspend, not noise). */
export function budgetFromEstimate(estimateUsd: number, cfg: BudgetConfig): number {
  return estimateUsd * cfg.headroom;
}

/** Has the real running total crossed the budget? A null budget (none set) never trips — the
 *  guard is opt-in per feature, and a feature with no budget runs as before. */
export function isOverBudget(totalUsd: number, budgetUsd: number | null): boolean {
  return budgetUsd !== null && totalUsd > budgetUsd;
}

/**
 * Average the recorded per-leg cost over the finished dispatches (the real instrument signal),
 * falling back to the config seed for any leg with no history yet. Each dispatch's leg cost is the
 * real reconciled number the daemon recorded (ADR 0026 decision 1). Pure over the rows passed in.
 */
export function legAveragesFrom(
  dispatches: { buildCostUsd: number | null; reviewCostUsd: number | null; amendCostUsd: number | null }[],
  seed: LegAverages,
): LegAverages {
  const avg = (pick: (d: (typeof dispatches)[number]) => number | null, fallback: number): number => {
    const vals = dispatches.map(pick).filter((v): v is number => v !== null && v > 0);
    return vals.length === 0 ? fallback : vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  return {
    build: avg((d) => d.buildCostUsd, seed.build),
    review: avg((d) => d.reviewCostUsd, seed.review),
    amend: avg((d) => d.amendCostUsd, seed.amend),
  };
}
