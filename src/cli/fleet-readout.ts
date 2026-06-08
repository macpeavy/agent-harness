// The pure fleet-wide status render function — a plain-text table to stdout.
// Accepts pre-joined fleet data and returns a formatted string; no I/O or filesystem access.
// ADR 0021 (fleet readout).

import { cheapAbleFraction } from "../substrate/dispatch/readout";
import type { DispatchState } from "../substrate/dispatch/model";
import type { FeatureState } from "../substrate/plan/model";

export interface DispatchRow {
  // from Dispatch
  id: string;
  state: DispatchState;
  route: string | null;
  amendRounds: number;
  escalated: string | null; // the escalation kind, e.g. 're-decompose'
  prUrl: string | null;
  buildCostUsd: number | null;
  reviewCostUsd: number | null;
  amendCostUsd: number | null;
  tier: string | null;
}

export interface ChunkRow {
  id: string;
  surface: string;
  dispatchId: string | null;
}

export interface FeatureRow {
  id: string;
  title: string;
  state: FeatureState;
}

export interface FleetData {
  features: FeatureRow[];
  chunksByFeatureId: Map<string, ChunkRow[]>;
  dispatchById: Map<string, DispatchRow>;
}

/**
 * Render the fleet-wide status as a plain-text string, newest features first.
 * Groups dispatches by feature. Shows per-dispatch rows with: chunk id, surface,
 * state, tier, route, amends, escalation, PR link, cost.
 * Footer: fleet totals from cheapAbleFraction().
 */
function renderFleetStatusImpl(data: FleetData): string {
  const lines: string[] = [];

  // Sort features newest first (simulated by sorting by id descending as a simple heuristic)
  const sortedFeatures = [...data.features].sort((a, b) => b.id.localeCompare(a.id));

  // Compute readout across ALL dispatches once
  const allDispatches = Array.from(data.dispatchById.values());
  // cheapAbleFraction expects the full Dispatch type, but our DispatchRow has the required fields
  const readout = cheapAbleFraction(allDispatches as any[]);

  for (const feature of sortedFeatures) {
    const chunks = data.chunksByFeatureId.get(feature.id) ?? [];

    // Feature header
    lines.push(`=== [${feature.state}] ${feature.id} "${feature.title}" ===`);

    if (chunks.length === 0) {
      lines.push("(no dispatches yet)");
      lines.push(""); // blank line separator
      continue;
    }

    // Group dispatches by feature for display
    for (const chunk of chunks) {
      if (!chunk.dispatchId) {
        // Skip chunks without dispatches for now
        continue;
      }

      const dispatch = data.dispatchById.get(chunk.dispatchId);
      if (!dispatch) {
        continue;
      }

      // Calculate cost
      const cost =
        (dispatch.buildCostUsd ?? 0) +
        (dispatch.reviewCostUsd ?? 0) +
        (dispatch.amendCostUsd ?? 0);

      // Format PR link or placeholder
      const prDisplay = dispatch.prUrl ?? "—";

      // Format escalation or placeholder
      const escalationDisplay = dispatch.escalated ?? "—";

      // Build the line with space-separated columns
      lines.push(
        `${chunk.id} | ${chunk.surface} | ${dispatch.state} | ${dispatch.tier ?? "—"} | ${dispatch.route ?? "—"} | ${dispatch.amendRounds} | ${escalationDisplay} | ${prDisplay} | $${cost.toFixed(4)}`,
      );
    }

    lines.push(""); // blank line separator
  }

  // Footer with fleet totals
  lines.push(
    `Fleet: ${readout.total} dispatches | cheap-able ${readout.cheapAbleFraction.toFixed(2)} | $${readout.blendedCostPerReadyUsd.toFixed(4)} blended/PR | $${readout.totalCostUsd.toFixed(4)} total`,
  );

  return lines.join("\n");
}

// Public API
export const renderFleetStatus = renderFleetStatusImpl;
