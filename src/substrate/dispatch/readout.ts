// The cheap-able-fraction readout — a pure function computing cost and quality
// metrics from the dispatch registry (ADR 0009). This module MUST NOT perform I/O
// or mutate state; it is called by the dashboard service to render widgets.

import type { Dispatch } from "./model";

export interface Readout {
  total: number;
  reachedReady: number;
  escalated: number;
  failed: number;
  inFlight: number;
  cheapAbleFraction: number;
  blendedCostPerReadyUsd: number;
  totalCostUsd: number;
  amendRoundsHistogram: Record<number, number>;
}

/**
 * Compute the cheap-able-fraction readout from a list of dispatches.
 * - Terminal states: done, escalated, failed
 * - Terminal count = all dispatches in terminal states
 * - cheapAbleFraction = reachedReady / terminalCount (0 when terminalCount = 0)
 * - blendedCostPerReadyUsd = totalCostAll / reachedReady (0 when reachedReady = 0)
 * - Total cost sums all legs, treating nulls as 0
 * - amendRoundsHistogram maps amendRounds values to dispatch counts
 */
export function cheapAbleFraction(dispatches: Dispatch[]): Readout {
  if (dispatches.length === 0) {
    return {
      total: 0,
      reachedReady: 0,
      escalated: 0,
      failed: 0,
      inFlight: 0,
      cheapAbleFraction: 0,
      blendedCostPerReadyUsd: 0,
      totalCostUsd: 0,
      amendRoundsHistogram: {},
    };
  }

  let total = 0;
  let reachedReady = 0;
  let escalated = 0;
  let failed = 0;
  let inFlight = 0;
  let totalCostUsd = 0;
  const amendRoundsHistogram: Record<number, number> = {};

  for (const d of dispatches) {
    total++;

    // Sum costs for every dispatch (nulls as 0) - costs are incurred regardless of state
    totalCostUsd += (d.buildCostUsd ?? 0) + (d.reviewCostUsd ?? 0) + (d.amendCostUsd ?? 0);

    // Track reachedReady (state === "done")
    if (d.state === "done") {
      reachedReady++;
    }
    // Count terminal states (escalated and failed are terminal, not "done")
    else if (d.state === "escalated") {
      escalated++;
    } else if (d.state === "failed") {
      failed++;
    } else {
      // Non-terminal states: queued, building, review, amending
      inFlight++;
    }

    // Track amend rounds histogram
    const rounds = d.amendRounds ?? 0;
    amendRoundsHistogram[rounds] = (amendRoundsHistogram[rounds] ?? 0) + 1;
  }

  // Terminal count = reachedReady + escalated + failed
  const terminalCount = reachedReady + escalated + failed;
  const cheapAbleFraction = terminalCount > 0 ? reachedReady / terminalCount : 0;

  // blendedCostPerReadyUsd = total cost across ALL dispatches / reachedReady
  const blendedCostPerReadyUsd = reachedReady > 0 ? totalCostUsd / reachedReady : 0;

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

export { cheapAbleFraction as default };
