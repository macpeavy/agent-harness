// Display helpers for USD amounts and durations.

/** Format a USD amount with a leading $ and 4 decimals, e.g. 0.0023 -> "$0.0023". */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) {
    return "$0.0000";
  }
  return `$${usd.toFixed(4)}`;
}

/** Format a millisecond duration compactly, e.g. 450 -> "450ms", 2_300 -> "2.3s",
 *  83_000 -> "1m 23s", 3_725_000 -> "1h 2m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0ms";
  }

  if (ms < 1_000) {
    return `${Math.floor(ms)}ms`;
  }

  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }

  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}
