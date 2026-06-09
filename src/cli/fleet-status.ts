// The fleet-status CLI — render live fleet status from the substrate DB.
// A pure renderFleet function takes the data and returns a terminal-friendly
// string. The import.meta.main entry wires repos, calls statusAll, and prints.
//
// Run: bun run src/cli/fleet-status.ts (or `make status`; needs env)

import { DispatchRepository } from "../substrate/dispatch";
import { PlanRepository } from "../substrate/plan";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import type { FeatureStatus } from "../dispatch/plan-dispatch";
import { ledgerPath, readSpendLedger, spendInWindow } from "../dispatch/litellm-spend";

/** The chief's reconciled spend per feature id, or null when it can't be measured (the spend
 *  ledger is empty/absent — no gateway callback has run). Keyed by feature id so the pure
 *  renderer stays I/O-free: the CLI reads the ledger and hands the answer in. */
export type ChiefCostByFeature = Map<string, number | null>;

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * Pure render — takes the data, returns a string. No I/O.
 * Tested directly by fleet-status.test.ts without touching the DB.
 *
 * `chiefCost` carries the chief's reconciled spend per feature (the CLI reads it from the spend
 * ledger; null = unmeasurable). The per-feature cost line distinguishes the TOTAL (chief + legs)
 * from the per-leg breakdown (ADR 0026) — the chief is counted, not invisible.
 */
export function renderFleet(
  statuses: FeatureStatus[],
  now = new Date().toISOString(),
  chiefCost: ChiefCostByFeature = new Map(),
): string {
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
  let aggregateChiefCost = 0;

  for (const feature of statuses) {
    lines.push("");
    const stateAndId = `[${feature.feature.state}] ${feature.feature.id} — "`;
    const availableForTitle = 80 - stateAndId.length - 1;
    const featureTitle = trunc(feature.feature.title, Math.max(10, availableForTitle));
    let featureLine = `${stateAndId}${featureTitle}"`;
    const budget = feature.feature.budgetUsd !== null ? ` — budget ${usd(feature.feature.budgetUsd)}` : "";
    featureLine += budget;
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

      if (session.budgetExceededUsd !== null) {
        const budgetPart = feature.feature.budgetUsd !== null ? ` / budget ${usd(feature.feature.budgetUsd)}` : "";
        const budgetLine = `  BUDGET-parked: spent ${usd(session.budgetExceededUsd)}${budgetPart} — raise / ship-partial / abandon`;
        lines.push(budgetLine.length > 80 ? budgetLine.slice(0, 79) : budgetLine);
      }

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

      const terminalCount = readout.reachedReady + readout.escalated + readout.failed;
      const totalReadout = terminalCount + readout.inFlight;
      const readoutLine =
        `  done ${readout.reachedReady} / esc ${readout.escalated} / fail ${readout.failed} / in-flight ${readout.inFlight}  ` +
        `cheap-able ${readout.cheapAbleFraction.toFixed(2)}  $${readout.blendedCostPerReadyUsd.toFixed(4)}`;
      lines.push(readoutLine);
    }

    // The per-feature cost line (ADR 0026): the TOTAL counts the chief, then breaks out chief vs
    // the per-leg spend so total and per-leg are never conflated. chief = null → "n/a" (the spend
    // ledger isn't populated), distinct from $0.0000 (ledger present, no chief calls in window).
    const c = feature.cost;
    const legsUsd = c.buildUsd + c.reviewUsd + c.amendUsd;
    const chief = chiefCost.get(feature.feature.id) ?? null;
    aggregateTotalCost += legsUsd;
    aggregateChiefCost += chief ?? 0;
    const featureTotal = legsUsd + (chief ?? 0);
    lines.push(`  cost: TOTAL ${usd(featureTotal)}  (chief ${chief === null ? "n/a" : usd(chief)} + legs ${usd(legsUsd)})`);
    lines.push(`        legs: build ${usd(c.buildUsd)} / review ${usd(c.reviewUsd)} / amend ${usd(c.amendUsd)}`);
  }

  const aggregateTerminal = aggregateDone + aggregateEscalated + aggregateFailed;
  const blendedCheapAble = aggregateTerminal > 0 ? aggregateDone / aggregateTerminal : 0;

  lines.push("");
  const grandTotal = aggregateTotalCost + aggregateChiefCost;
  lines.push(
    `Features: ${statuses.length}  Sessions: ${totalSessions}  Chunks: ${totalChunks}  ` +
      `cheap-able ${blendedCheapAble.toFixed(2)} (blended)`,
  );
  lines.push(`Total ${usd(grandTotal)}  (chief ${usd(aggregateChiefCost)} + legs ${usd(aggregateTotalCost)})`);

  return lines.join("\n");
}

if (import.meta.main) {
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  const dispatch = dbPath ? new DispatchRepository(dbPath) : new DispatchRepository();
  const service = new PlanDispatchService(plan, dispatch);

  try {
    const statuses = service.statusAll();
    // Reconcile the chief's real spend per feature from the gateway ledger (ADR 0026): route
    // `chief` summed over each feature's attribution window. Read once; null when the ledger is
    // empty/absent (no callback has run) so the renderer shows "n/a", not a misleading $0.
    const ledger = readSpendLedger(ledgerPath(process.env.AH_REPO ?? process.cwd()));
    const chiefCost: ChiefCostByFeature = new Map(
      statuses.map((s) => [
        s.feature.id,
        ledger.length === 0 ? null : spendInWindow(ledger, "chief", s.cost.window.start, s.cost.window.end),
      ]),
    );
    console.log(renderFleet(statuses, undefined, chiefCost));
  } finally {
    plan.close();
    dispatch.close();
  }
}
