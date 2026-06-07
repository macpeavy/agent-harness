// The cheap-able-fraction readout (ADR 0009 instrument). A pure function over
// dispatch rows producing cost-and-quality metrics. No I/O, no database access.

import type { Dispatch } from "./model";

/** The readout structure produced by cheapAbleFraction(). */
export interface Readout {
  total: number; // all dispatches passed in
  reachedReady: number; // state === "done"
  escalated: number; // state === "escalated"
  failed: number; // state === "failed"
  inFlight: number; // not yet terminal (queued/building/review/amending)
  cheapAbleFraction: number; // reachedReady / (terminal count); 0 when no terminal dispatches
  blendedCostPerReadyUsd: number; // (Σ every leg cost over ALL dispatches) / reachedReady; 0 when reachedReady === 0
  totalCostUsd: number; // Σ (buildCostUsd + reviewCostUsd + amendCostUsd) over all dispatches, nulls as 0
  amendRoundsHistogram: Record<number, number>; // amendRounds value → count of dispatches with it
}

/** Compute the cheap-able-fraction readout from a list of dispatches. */
export function cheapAbleFraction(dispatches: Dispatch[]): Readout {
  let total = 0;
  let reachedReady = 0;
  let escalated = 0;
  let failed = 0;
  let inFlight = 0;
  let totalCostUsd = 0;
  const amendRoundsHistogram: Record<number, number> = {};

  for (const d of dispatches) {
    total += 1;
    const cost =
      (d.buildCostUsd ?? 0) + (d.reviewCostUsd ?? 0) + (d.amendCostUsd ?? 0);
    totalCostUsd += cost;

    // Track amend rounds histogram
    const rounds = d.amendRounds;
    amendRoundsHistogram[rounds] = (amendRoundsHistogram[rounds] ?? 0) + 1;

    switch (d.state) {
      case "done":
        reachedReady += 1;
        break;
      case "escalated":
        escalated += 1;
        break;
      case "failed":
        failed += 1;
        break;
      default:
        inFlight += 1;
    }
  }

  const terminalCount = reachedReady + escalated + failed;
  const cheapAbleFraction = terminalCount === 0 ? 0 : reachedReady / terminalCount;
  const blendedCostPerReadyUsd = reachedReady === 0 ? 0 : totalCostUsd / reachedReady;

  return {
    total,
    reachedReady,
    escalated,
    failed,
    inFlight,
    cheapAbleFraction,
    blendedCostPerReadyUsd,
    totalCostUsd,
    amendRoundsHistogram,
  };
}
