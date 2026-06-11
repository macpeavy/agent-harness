// The history render layer — given a FeatureHistory, return a terminal-friendly
// plain-text string showing the complete feature story. Pure: no I/O, no side effects.
// The output is ≤100 chars/line, no ANSI color.

import type { FeatureHistory } from "./history-assemble";
import { sessionStateLabel } from "./session-state-label";

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function isoTrunc(ms: number, max: number = 20): string {
  const iso = new Date(ms).toISOString();
  return trunc(iso, max);
}

/** Pure. Returns a multi-line plain-text string. Lines <=100 chars. Truncates with '…'. No ANSI. */
export function renderHistory(history: FeatureHistory): string {
  const lines: string[] = [];

  const stateAndId = `[${history.feature.state}] ${history.feature.id} — "`;
  const availableForTitle = 100 - stateAndId.length - 1;
  const featureTitle = trunc(history.feature.title, Math.max(10, availableForTitle));
  const featureLine = `${stateAndId}${featureTitle}"`;
  lines.push(featureLine.length > 100 ? featureLine.slice(0, 99) : featureLine);

  const rollupLine =
    `  sessions: ${history.sessions.length}  chunks: ${countChunks(history)}  ` +
    `cost: ${usd(history.totalCostUsd)} (${history.chiefCostNote})  ` +
    `escalations: ${history.totalEscalations}`;
  lines.push(rollupLine.length > 100 ? rollupLine.slice(0, 99) : rollupLine);

  for (const session of history.sessions) {
    // Session states render in owner language (AGENT-52): `review` = awaiting the owner.
    const stateLabel = sessionStateLabel(session.session.state);
    let sessionLine = `  session ${session.session.id} [${stateLabel}]`;
    if (session.session.prNumber != null) {
      sessionLine += `  PR #${session.session.prNumber}`;
    }
    if (session.session.locEstimate != null) {
      sessionLine += `  ~${session.session.locEstimate} LOC`;
    }
    if (sessionLine.length > 100) {
      const sessId = trunc(session.session.id, 30);
      sessionLine = `  session ${sessId} [${stateLabel}]`;
      if (session.session.prNumber != null) {
        sessionLine += `  PR #${session.session.prNumber}`;
      }
      if (session.session.locEstimate != null) {
        sessionLine += `  ~${session.session.locEstimate} LOC`;
      }
    }
    if (sessionLine.length > 100) {
      sessionLine = sessionLine.slice(0, 99);
    }
    lines.push(sessionLine);

    for (const chunk of session.chunks) {
      const prefix = `    `;
      const suffix = `  [${chunk.chunk.state}]`;
      const availableSpace = 100 - prefix.length - suffix.length;
      const surfaceSpace = Math.floor(availableSpace * 0.6);
      const surface = trunc(chunk.chunk.surface, surfaceSpace);
      const chunkLine = `${prefix}chunk ${chunk.chunk.id}  ${surface}${suffix}`;
      lines.push(chunkLine.length > 100 ? chunkLine.slice(0, 99) : chunkLine);

      if (chunk.dependsOn.length > 0) {
        const depsStr = chunk.dependsOn.join(", ");
        const depsLine = `      depends on: ${depsStr}`;
        lines.push(depsLine.length > 100 ? depsLine.slice(0, 99) : depsLine);
      }

      for (const event of chunk.events) {
        const timestamp = isoTrunc(event.timestampMs);
        if (event.kind === "escalated" && event.escalationKind) {
          const reason = event.escalationReason ?? "—";
          const eventLine = `      ${timestamp}  ESCALATED ${event.escalationKind}: ${reason}`;
          lines.push(eventLine.length > 100 ? eventLine.slice(0, 99) : eventLine);
        } else if (event.costUsd > 0) {
          const cost = usd(event.costUsd);
          const eventLine = `      ${timestamp}  ${event.kind}  ${cost}`;
          lines.push(eventLine.length > 100 ? eventLine.slice(0, 99) : eventLine);
        } else {
          const eventLine = `      ${timestamp}  ${event.kind}`;
          lines.push(eventLine.length > 100 ? eventLine.slice(0, 99) : eventLine);
        }
      }
    }

    const sessionCostLine = `  session cost: ${usd(session.totalCostUsd)}`;
    lines.push(sessionCostLine);
  }

  if (history.totalEscalations > 0) {
    lines.push(`ESCALATIONS (${history.totalEscalations})`);
    for (const session of history.sessions) {
      for (const esc of session.escalations) {
        const reason = esc.reason ?? "—";
        const escLine = `  ${esc.chunkId}  dispatch ${esc.dispatchId}  ${esc.kind}  ${reason}`;
        lines.push(escLine.length > 100 ? escLine.slice(0, 99) : escLine);
      }
    }
  }

  lines.push("COST ROLLUP");
  for (const session of history.sessions) {
    const line = `  ${session.session.id}: ${usd(session.totalCostUsd)}`;
    lines.push(line);
  }
  const totalLine = `  TOTAL: ${usd(history.totalCostUsd)} (${history.chiefCostNote})`;
  lines.push(totalLine.length > 100 ? totalLine.slice(0, 99) : totalLine);

  return lines.join("\n");
}

function countChunks(history: FeatureHistory): number {
  let count = 0;
  for (const session of history.sessions) {
    count += session.chunks.length;
  }
  return count;
}
