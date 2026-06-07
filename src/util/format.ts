// Display helpers for USD amounts and durations.

/**
 * Format a number as a USD amount with a leading $ and 4 decimal places.
 * 
 * @param amount - The numeric amount to format. Non-finite values (NaN, Infinity, -Infinity)
 *                 and negative numbers are converted to $0.0000.
 * @returns Formatted USD string with leading $ and 4 decimal places (e.g., 0.0023 -> "$0.0023")
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    return "$0.0000";
  }
  return `$${amount.toFixed(4)}`;
}

/**
 * Format a millisecond duration into a human-readable compact string.
 * 
 * Converts millisecond values into appropriate units (ms, s, m, h) with smart rounding:
 * - Less than 1000ms -> "Xms"
 * - Between 1000ms and 60000ms -> "X.Xs" (one decimal place)
 * - Between 60000ms and 3600000ms -> "Xm Ys" (minutes and seconds, both integers)
 * - 3600000ms and above -> "Xh Ym" (hours and minutes, both integers)
 * 
 * Negative values and non-finite numbers return "0ms".
 * 
 * @param ms - Milliseconds to format. Must be a finite number >= 0.
 * @returns Formatted duration string with appropriate unit (e.g., 450 -> "450ms",
 *          2300 -> "2.3s", 83000 -> "1m 23s", 3725000 -> "1h 2m")
 */
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
