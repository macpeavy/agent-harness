// The fleet-status CLI — render live fleet status from the substrate DB.
// A pure renderFleet function takes the data and returns a terminal-friendly
// string. The import.meta.main entry wires repos, calls statusAll, and prints.
//
// Run: bun run src/cli/fleet-status.ts (or `make status`; needs env)

import { DispatchRepository } from "../substrate/dispatch";
import { PlanRepository } from "../substrate/plan";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import type { FeatureStatus } from "../dispatch/plan-dispatch";

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Pure render — takes the data, returns a string. No I/O.
 * Tested directly by fleet-status.test.ts without touching the DB.
 */
export function renderFleet(statuses: FeatureStatus[], now = new Date().toISOString()): string {
  const lines: string[] = [];

  lines.push(`Fleet status — ${now}`);

  if (statuses.length === 0) {
    lines.push("(no features)");
    return lines.join("\n");
  }

  let totalChunks = 0;
  let totalSessions = 0;
  let aggregateDone = 0;
  let aggregateEscalated = 0;
  let aggregateFailed = 0;
  let aggregateInFlight = 0;
  let aggregateCheapAble = 0;
  let aggregateTotalCost = 0;

  for (const feature of statuses) {
    lines.push("");
    const stateAndId = `[${feature.feature.state}] ${feature.feature.id} — "`;
    const availableForTitle = 80 - stateAndId.length - 1;
    const featureTitle = trunc(feature.feature.title, Math.max(10, availableForTitle));
    let featureLine = `${stateAndId}${featureTitle}"`;
    if (featureLine.length > 80) {
      featureLine = featureLine.slice(0, 79);
    }
    lines.push(featureLine);

    for (const sessionStatus of feature.sessions) {
      const session = sessionStatus.session;
      totalSessions++;

      let sessionLine = `  ${session.id} [${session.state}]`;
      if (session.prNumber != null) {
        sessionLine += `  PR #${session.prNumber}`;
      }
      if (session.locEstimate != null) {
        sessionLine += `  ~${session.locEstimate} LOC`;
      }
      if (sessionLine.length > 80) {
        const sessionId = trunc(session.id, 30);
        sessionLine = `  ${sessionId} [${session.state}]`;
        if (session.prNumber != null) {
          sessionLine += `  PR #${session.prNumber}`;
        }
        if (session.locEstimate != null) {
          sessionLine += `  ~${session.locEstimate} LOC`;
        }
      }
      if (sessionLine.length > 80) {
        sessionLine = sessionLine.slice(0, 79);
      }
      lines.push(sessionLine);

      for (const chunk of sessionStatus.chunks) {
        totalChunks++;
        const dispatchStateStr = chunk.dispatchState ?? "-";
        const prefix = `    `;
        const suffix = `  [${chunk.state}]  dispatch: ${dispatchStateStr}`;
        const availableSpace = 80 - prefix.length - suffix.length;
        const chunkIdSpace = Math.floor(availableSpace * 0.4);
        const surfaceSpace = availableSpace - chunkIdSpace - 2;
        const chunkId = trunc(chunk.id, chunkIdSpace);
        const surface = trunc(chunk.surface, surfaceSpace);
        const chunkLine = `${prefix}${chunkId}  ${surface}${suffix}`;
        lines.push(chunkLine.length > 80 ? chunkLine.slice(0, 79) : chunkLine);
      }

      const readout = sessionStatus.readout;
      aggregateDone += readout.reachedReady;
      aggregateEscalated += readout.escalated;
      aggregateFailed += readout.failed;
      aggregateInFlight += readout.inFlight;
      aggregateCheapAble += readout.reachedReady;
      aggregateTotalCost += readout.totalCostUsd;

      const terminalCount = readout.reachedReady + readout.escalated + readout.failed;
      const totalReadout = terminalCount + readout.inFlight;
      const readoutLine =
        `  done ${readout.reachedReady} / esc ${readout.escalated} / fail ${readout.failed} / in-flight ${readout.inFlight}  ` +
        `cheap-able ${readout.cheapAbleFraction.toFixed(2)}  $${readout.blendedCostPerReadyUsd.toFixed(4)}`;
      lines.push(readoutLine);
    }
  }

  const aggregateTerminal = aggregateDone + aggregateEscalated + aggregateFailed;
  const blendedCheapAble = aggregateTerminal > 0 ? aggregateDone / aggregateTerminal : 0;

  lines.push("");
  const footerLine =
    `Features: ${statuses.length}  Sessions: ${totalSessions}  Chunks: ${totalChunks}  ` +
    `cheap-able ${blendedCheapAble.toFixed(2)} (blended)  $${aggregateTotalCost.toFixed(4)} total`;
  lines.push(footerLine);

  return lines.join("\n");
}

if (import.meta.main) {
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = new PlanRepository(dbPath ?? undefined, { migrate: false });
  const dispatch = new DispatchRepository(dbPath ?? undefined, { migrate: false });
  const service = new PlanDispatchService(plan, dispatch);

  try {
    const statuses = service.statusAll();
    console.log(renderFleet(statuses));
  } finally {
    plan.close();
    dispatch.close();
  }
}
