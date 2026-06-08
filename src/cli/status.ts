// The fleet-status CLI (one-shot ADR 0014/0020) — renders every feature →
// sessions → chunks with state, PR linkage, and cost readouts, plus a fleet
// footer with the cheap-able fraction and blended $/ready PR. Pure read — no
// mutations; the cheapest report the substrate can offer (so it's a CLI the
// chief calls from anywhere they have the substrate binary).
//
// Run: bun run src/cli/status.ts

import { loadConfig } from "../config";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanRepository } from "../substrate/plan";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import { cheapAbleFraction } from "../substrate/dispatch/readout";

export interface FeatureStatus {
  feature: { id: string; title: string; state: string };
  sessions: SessionStatus[];
}

export interface SessionStatus {
  session: {
    id: string;
    state: string;
    branch: string | null;
    prNumber: number | null;
    prUrl: string | null;
    locEstimate: number | null;
    lastError: string | null;
  };
  chunks: ChunkStatus[];
  readout: Readout;
  escalations: ParkedEscalation[];
}

export interface ChunkStatus {
  id: string;
  surface: string;
  state: string;
  dispatchId: string | null;
  dispatchState: string | null;
}

export interface Readout {
  cheapAbleFraction: number;
  blendedCostPerReadyUsd: number;
  totalCostUsd: number;
  reachedReady: number;
  total: number;
  escalated: number;
  failed: number;
  inFlight: number;
}

export interface ParkedEscalation {
  chunkId: string;
  dispatchId: string;
  kind: string;
  reason: string | null;
}

/** Render the whole fleet, then return the rendered string. */
export function renderFleetStatus(statuses: FeatureStatus[]): string {
  const lines: string[] = [];
  
  // Header
  lines.push(`Fleet status — ${new Date().toISOString()}`);
  lines.push("");
  
  // Calculate fleet-wide aggregations
  let fleetTotalCostUsd = 0;
  let fleetReachedReady = 0;
  let fleetTerminalCount = 0;
  
  if (statuses.length > 0) {
    for (const fs of statuses) {
      for (const ss of fs.sessions) {
        fleetTotalCostUsd += ss.readout.totalCostUsd;
        fleetReachedReady += ss.readout.reachedReady;
        fleetTerminalCount += ss.readout.total; // Total terminal across all dispatches (terminal = done + escalated + failed)
      }
    }
    
    const fleetCheapAbleFraction = fleetTerminalCount > 0 ? fleetReachedReady / fleetTerminalCount * 100 : 0;
    const fleetBlendedCostPerReady = fleetReachedReady > 0 ? fleetTotalCostUsd / fleetReachedReady : 0;
    
    // Footer
    lines.push(`Fleet: cheap-able ${fleetCheapAbleFraction.toFixed(2)}%  blended $/PR: $${fleetBlendedCostPerReady.toFixed(2)}  total: $${fleetTotalCostUsd.toFixed(2)}`);
  } else {
    lines.push("Fleet: cheap-able 0.00%  blended $/PR: $0.00  total: $0.00");
  }
  
  // Per-feature
  for (const fs of statuses) {
    lines.push(`Feature ${fs.feature.id} "${fs.feature.title}" — ${fs.feature.state}`);
    lines.push("");
    
    // Per-session
    for (const ss of fs.sessions) {
      const prLine = ss.session.prNumber && ss.session.prUrl ? `PR #${ss.session.prNumber} | ${ss.session.prUrl}` : "no PR";
      lines.push(`  Session ${ss.session.id} [${ss.session.state}] ${prLine} | ~${ss.session.locEstimate ?? 0} LOC`);
      
      if (ss.session.lastError) {
        lines.push(`    ⚠ ${ss.session.lastError}`);
      }
      
      // Per-chunk
      for (const cs of ss.chunks) {
        const dispatchSuffix = cs.dispatchId && cs.dispatchState ? ` [${cs.dispatchState}]` : "";
        lines.push(`    ${cs.id}  ${cs.surface}  ${cs.state}${dispatchSuffix}`);
      }
      
      // Session readout
      const donePct = ss.readout.total > 0 ? ((ss.readout.reachedReady / ss.readout.total) * 100).toFixed(1) : "0.0";
      lines.push(`  Readout: ${ss.readout.reachedReady}/${ss.readout.total} done  cheap-able ${donePct}%  $${ss.readout.totalCostUsd.toFixed(2)} total`);
      lines.push("");
      
      // Escalations
      if (ss.escalations.length > 0) {
        for (const esc of ss.escalations) {
          const reason = esc.reason ? `: ${esc.reason}` : "";
          lines.push(`  🔍 Escalated: ${esc.kind} for chunk ${esc.chunkId}${reason}`);
        }
        lines.push("");
      }
    }
  }
  
  return lines.join("\n");
}

if (import.meta.main) {
  const config = await loadConfig();
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath, { migrate: false }) : new PlanRepository(undefined, { migrate: false });
  const dispatch = dbPath ? new DispatchRepository(dbPath, { migrate: false }) : new DispatchRepository(undefined, { migrate: false });
  const service = new PlanDispatchService(plan, dispatch);

  try {
    // Get list of all features and their status
    const features = plan.listAllFeatures();
    const statuses: FeatureStatus[] = [];
    
    for (const feature of features) {
      const featureStatus = service.status(feature.id);
      statuses.push(featureStatus);
    }
    
    // Render
    console.log(renderFleetStatus(statuses));
  } finally {
    plan.close();
    dispatch.close();
  }
}
