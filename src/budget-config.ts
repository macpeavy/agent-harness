// Budget dials (ADR 0026 decision 2) — the cost circuit-breaker config, loaded from
// config/budget.yaml. A sibling to ./decomposition-config.ts (same file-based, zod-validated
// pattern): these are tuned cost dials, not deployment wiring. The estimate they feed is a gate
// forecast (decision-support), never recorded spend — recorded cost is the real ledger numbers
// (ADR 0026 decision 1).

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const LEG_AVERAGES = z.object({
  build: z.number().nonnegative(),
  review: z.number().nonnegative(),
  amend: z.number().nonnegative(),
});

const SCHEMA = z.object({
  /** Budget = estimate × headroom — absorbs normal per-leg variance so the guard trips on a real
   *  overspend, not noise. */
  headroom: z.number().positive(),
  /** Expected amend rounds per chunk folded into the estimate (ADR 0008). */
  expectedAmendRounds: z.number().nonnegative(),
  /** The chief's typical per-feature decomposition cost, added once to a feature's estimate. */
  decompositionSeedUsd: z.number().nonnegative(),
  /** Cold-start per-leg averages — used only until enough real done-dispatch history exists. */
  seedAverages: LEG_AVERAGES,
});

export type BudgetConfig = z.infer<typeof SCHEMA>;

/** Seed defaults — used when config/budget.yaml is absent so a missing dials file never bricks
 *  the gate; the shipped config carries these same values, tuned later by the instrument. */
export const DEFAULT_BUDGET: BudgetConfig = {
  headroom: 1.5,
  expectedAmendRounds: 1,
  decompositionSeedUsd: 0.6,
  seedAverages: { build: 0.15, review: 0.4, amend: 0.15 },
};

const DEFAULT_PATH = "config/budget.yaml";

/**
 * Load + validate the budget dials. A missing file falls back to the seed defaults (soft
 * guidance, not load-bearing wiring); a present-but-malformed file throws — a committed config
 * error should fail loudly, not silently revert to a different number.
 */
export function loadBudgetConfig(path: string = DEFAULT_PATH): BudgetConfig {
  if (!existsSync(path)) return DEFAULT_BUDGET;
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  const result = SCHEMA.safeParse(parsed);
  if (!result.success) throw new Error(`invalid ${path}: ${result.error.message}`);
  return result.data;
}
