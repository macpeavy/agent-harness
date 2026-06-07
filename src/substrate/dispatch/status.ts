// The harness status renderer (one-time actionable observability table).
//
// Renders the dispatch registry as a compact, aligned terminal table plus a thin
// `import.meta.main` runnable entrypoint that calls `DispatchRepository.list()` and
// prints the table to stdout. Pure `renderStatus` for tests; the runnable is untouched
// by tests to avoid real-database hits in unit tests.

import type { Dispatch } from "./schema";
import { DispatchRepository } from "./repository";

/** Render dispatches as an aligned plain-text table. Pure — renders the rows given,
 *  in the order given. */
export function renderStatus(dispatches: Dispatch[]): string {
  if (dispatches.length === 0) {
    return "No dispatches.";
  }

  const headers = ["ID", "STATE", "ROUTE", "AMENDS", "COST"] as const;
  
  // Collect all cells and compute row data
  const columnValues: [string, string, string, string, string][] = [];
  
  for (const d of dispatches) {
    const routeStr = d.route ?? "—";
    const cost = (d.buildCostUsd ?? 0) + (d.reviewCostUsd ?? 0) + (d.amendCostUsd ?? 0);
    const costStr = `$${cost.toFixed(4)}`;
    
    columnValues.push([
      d.id,
      d.state,
      routeStr,
      d.amendRounds.toString(),
      costStr,
    ]);
  }

  // Compute column widths: each column's max printed width (including header)
  const padEndWidths: [number, number, number, number, number] = [
    Math.max(headers[0].length, ...columnValues.map((r) => r[0].length)),
    Math.max(headers[1].length, ...columnValues.map((r) => r[1].length)),
    Math.max(headers[2].length, ...columnValues.map((r) => r[2].length)),
    Math.max(headers[3].length, 0),
    Math.max(headers[4].length, 0),
  ] as const;

  const padStartWidths: [number, number, number, number, number] = [
    padEndWidths[0],
    padEndWidths[1],
    padEndWidths[2],
    Math.max(headers[3].length, ...columnValues.map((r) => r[3].length)),
    Math.max(headers[4].length, ...columnValues.map((r) => r[4].length)),
  ] as const;

  // Build the header followed by data rows
  const lines: string[] = [];

  // Header line (text columns left-aligned, numeric right-aligned)
  lines.push(
    headers[0].padEnd(padEndWidths[0]) +
    "  " +
    headers[1].padEnd(padEndWidths[1]) +
    "  " +
    headers[2].padEnd(padEndWidths[2]) +
    "  " +
    headers[3].padStart(padStartWidths[3]) +
    "  " +
    headers[4].padStart(padStartWidths[4])
  );

  // Data rows
  for (const row of columnValues) {
    lines.push(
      row[0].padEnd(padEndWidths[0]) +
      "  " +
      row[1].padEnd(padEndWidths[1]) +
      "  " +
      row[2].padEnd(padEndWidths[2]) +
      "  " +
      row[3].padStart(padStartWidths[3]) +
      "  " +
      row[4].padStart(padStartWidths[4])
    );
  }

  return lines.join("\n");
}

// --- Thin runnable that opens the repo, lists, and prints ---

if (import.meta.main) {
  const repo = new DispatchRepository();
  const list = repo.list();
  console.log(renderStatus(list));
  repo.close();
}
