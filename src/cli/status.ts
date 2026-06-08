// Fleet status CLI — one-shot human-readable observability table.
//
// Renders all features → sessions → chunks with their state, PR, and cost; plus
// a fleet footer with the cheap-able fraction, blended $/PR, and total fleet cost.
// Uses no ANSI — watch/tmux rendering can handle formatting. Pure `renderFleetStatus`
// for tests; the runnable entrypoint hits the db read-only and prints to stdout.

import type { FeatureStatus, SessionStatus, ChunkStatus } from "../dispatch/plan-dispatch";
import { PlanRepository } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import { loadConfig } from "../config";

// Runnable: bun run src/cli/status.ts
// Exported for tests:
export function renderFleetStatus(statuses: FeatureStatus[]): string {
  if (statuses.length === 0) {
    return "Fleet status — (no features at planning or later)\n\nFleet: cheap-able 0.00%  blended $/PR: $0.0000  total: $0.0000";
  }

  const lines: string[] = [];
  const timestampPrefix = "Fleet status — ";
  lines.push(`${timestampPrefix}${new Date().toISOString()}`);
  lines.push("");

  // Per feature section
  for (const fs of statuses) {
    lines.push(`Feature ${fs.feature.id} "${fs.feature.title}" — ${fs.feature.state}`);

    // Per session section
    for (const ss of fs.sessions) {
      const sessionLineParts: string[] = [`  Session ${ss.session.id} [${ss.session.state}]`];

      if (ss.session.prNumber != null) {
        sessionLineParts.push(`PR #${ss.session.prNumber}`);
        if (ss.session.prUrl) sessionLineParts.push(`| ${ss.session.prUrl}`);
      }

      if (ss.session.locEstimate != null) {
        sessionLineParts.push(`| ~${ss.session.locEstimate} LOC`);
      }

      lines.push(sessionLineParts.join(" "));

      // Per chunk lines
      for (const cs of ss.chunks) {
        const chunkParts: string[] = [
          `    ${cs.id}`,
          cs.surface,
          cs.state,
        ];

          if (cs.dispatchId && cs.dispatchState) {
          chunkParts.push(`[${cs.dispatchState}]`);
        } else if (cs.dispatchState) {
          chunkParts.push(`[${cs.dispatchState}]`);
        }

        // Add cost from readout.totalCostUsd (aggregated per session)
        const chunkCost = ss.readout.totalCostUsd > 0 ? ` $${ss.readout.totalCostUsd.toFixed(4)}` : "" ;
        chunkParts.push(chunkCost);
        lines.push(chunkParts.filter(Boolean).join("  "));
      }

      // Session readout line - use terminal = reachedReady + escalated + failed
      const terminal = ss.readout.reachedReady + ss.readout.escalated + ss.readout.failed;
      const cheapAbleFraction = terminal > 0 ? (ss.readout.reachedReady / terminal) * 100 : 0;
      lines.push(
        `  Readout: ${ss.readout.reachedReady}/${terminal} done  ` +
        `cheap-able ${cheapAbleFraction.toFixed(1)}%  $${ss.readout.totalCostUsd.toFixed(4)} total`
      );

      // Escalations lines (if any)
      if (ss.escalations.length > 0) {
        for (const esc of ss.escalations) {
          lines.push(
            `  Escalation: ${esc.chunkId} | dispatch ${esc.dispatchId} | kind ${esc.kind}` +
            (esc.reason ? ` | reason: ${esc.reason}` : "")
          );
        }
      }

      lines.push("");
    }
  }

  // Fleet footer: aggregate across all sessions
  const fleetTotals = computeFleetAggregates(statuses);

  lines.push(
    `Fleet: cheap-able ${fleetTotals.cheapAblePct.toFixed(2)}%  ` +
    `blended $/PR: $${fleetTotals.blendedCostPerPr.toFixed(4)}  ` +
    `total: $${fleetTotals.totalCostUsd.toFixed(4)}`
  );

  return lines.join("\n");
}

/** Aggregate cheap-able fraction and blended cost across all feature sessions. */
function computeFleetAggregates(statuses: FeatureStatus[]): {
  cheapAblePct: number;
  blendedCostPerPr: number;
  totalCostUsd: number;
} {
  let totalReady = 0;
  let totalTerminal = 0;
  let totalCostUsd = 0;

  for (const fs of statuses) {
    for (const ss of fs.sessions) {
      totalReady += ss.readout.reachedReady;
      totalTerminal += ss.readout.reachedReady + ss.readout.escalated + ss.readout.failed;
      totalCostUsd += ss.readout.totalCostUsd;
    }
  }

  const cheapAbleFraction = totalTerminal > 0 ? totalReady / totalTerminal : 0;
  const cheapAblePct = cheapAbleFraction * 100;
  const totalPrs = totalTerminal; // Each terminal session is a PR-ready unit
  const blendedCostPerPr = totalPrs > 0 ? totalCostUsd / totalPrs : 0;

  return { cheapAblePct, blendedCostPerPr, totalCostUsd };
}

// --- Thin runnable that opens repos, fetches all feature statuses, and prints ---

if (import.meta.main) {
  const config = await loadConfig();
  const dbPath = process.env.SUBSTRATE_DB;
  
  // Open repos read-only (no migrations applied)
  const plan = new PlanRepository(dbPath, { migrate: false });
  const dispatch = new DispatchRepository(dbPath, { migrate: false });
  const service = new PlanDispatchService(plan, dispatch);

  try {
    // List all features (PlanRepository has no listAllFeatures(); we read directly)
    // Since db is private, import features schema reference
    const { features } = (await import("../substrate/plan/schema"));
    
    const featuresList = (plan as any).db
      .select()
      .from(features as any)
      .all() as { id: string; title: string; state: string }[];

    const statuses = featuresList.map((f) => service.status(f.id));
    console.log(renderFleetStatus(statuses));
  } finally {
    plan.close();
    dispatch.close();
  }
}
