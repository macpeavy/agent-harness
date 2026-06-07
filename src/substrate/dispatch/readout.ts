/**
 * The readout structure produced by cheapAbleFraction().
 * Records metrics on dispatch execution and costs.
 */
export interface Readout {
  /** Total number of dispatches processed. */
  total: number;
  /** Number of dispatches that reached 'done' state. */
  reachedReady: number;
  /** Number of dispatches that were escalated. */
  escalated: number;
  /** Number of dispatches that failed. */
  failed: number;
  /** Number of dispatches still in-flight (not terminal). */
  inFlight: number;
  /** Fraction of terminal dispatches that reached ready state (0 when no terminal dispatches). */
  cheapAbleFraction: number;
  /** Average cost per ready dispatch in USD (0 when no ready dispatches). */
  blendedCostPerReadyUsd: number;
  /** Total cost of all dispatches in USD, with null costs treated as 0. */
  totalCostUsd: number;
  /** Histogram mapping amend rounds (non-negative integers) to count of dispatches with that value. */
  amendRoundsHistogram: Record<number, number>;
}

// Named constants for magic numbers used in metrics
const NO_TERMINAL_DISPATCHES = 0;
const NO_READY_DISPATCHES = 0;

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

    // Track amend rounds histogram - normalize to non-negative integers
    const rounds = Math.max(0, Math.floor(d.amendRounds));
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
  const cheapAbleFraction = terminalCount === NO_TERMINAL_DISPATCHES ? 0 : reachedReady / terminalCount;
  const blendedCostPerReadyUsd = reachedReady === NO_READY_DISPATCHES ? 0 : totalCostUsd / reachedReady;

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
