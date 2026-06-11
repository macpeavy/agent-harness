// The fleet-status CLI — render live fleet status from the substrate DB.
// A pure renderFleet function takes the data and returns a terminal-friendly
// string. The import.meta.main entry wires repos, calls statusAll, and prints.
//
// Run: bun run src/cli/fleet-status.ts (or `make status`; needs env)

import { DispatchRepository } from "../substrate/dispatch";
import { PlanRepository } from "../substrate/plan";
import { RuntimeRepository } from "../substrate/runtime";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import type { FeatureStatus } from "../dispatch/plan-dispatch";
import { assessHeartbeats, formatAge, type DriverHealth } from "../dispatch/heartbeat";
import { ledgerPath, readSpendLedger, spendInWindow } from "../dispatch/litellm-spend";
import { sessionStateLabel } from "./session-state-label";

/** The chief's reconciled spend per feature id, or null when it can't be measured (the spend
 *  ledger is empty/absent — no gateway callback has run). Keyed by feature id so the pure
 *  renderer stays I/O-free: the CLI reads the ledger and hands the answer in. */
export type ChiefCostByFeature = Map<string, number | null>;

// The compact pane fits a narrow (~20%-width) tmux column, so the render targets a fixed small
// width and truncates to it — wide 80-col lines wrapped into mush in the pane (the owner's note).
const WIDTH = 34;
const RULE = "─".repeat(WIDTH);

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Compact money — cents precision is enough at a glance (the pane is for scanning, not auditing;
 *  `make status` / the chief's tool carry the 4-dp figures). */
function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function featureTotal(f: FeatureStatus, chiefCost: ChiefCostByFeature): number {
  const legs = f.cost.buildUsd + f.cost.reviewUsd + f.cost.amendUsd;
  return legs + (chiefCost.get(f.feature.id) ?? 0);
}

// The driver names the fleet expects to be beating (AGENT-44) — a missing row renders as
// "no heartbeat yet" so a never-started driver is visible, not just a crashed one.
const EXPECTED_DRIVERS = ["daemon", "session-loop"];

/** One compact drivers line: `drv daemon 4s · session-loop ⚠4m` — ⚠ marks stale (down?). */
export function renderDrivers(drivers: DriverHealth[], expected: string[] = EXPECTED_DRIVERS): string {
  const byName = new Map(drivers.map((d) => [d.driver, d]));
  const parts = expected.map((name) => {
    const d = byName.get(name);
    if (!d) return `${name} —`;
    return d.stale ? `${name} ⚠${formatAge(d.ageMs)}` : `${name} ${formatAge(d.ageMs)}`;
  });
  return `drv ${parts.join(" · ")}`;
}

/**
 * Pure render — takes the data, returns a string. No I/O. Tested directly by fleet-status.test.ts.
 *
 * A compact card per ACTIVE feature (abandoned ones collapse to a count), sized for the narrow
 * watch pane: id, a budget-park alert when tripped, the lead session's state/PR/LOC, and a
 * one-line chunk tally + the real TOTAL cost (chief + legs, ADR 0026). `chiefCost` is the chief's
 * reconciled spend per feature (the CLI reads it from the ledger; null counts as 0 here).
 * `drivers` is the assessed driver liveness (AGENT-44) — a stale driver gets a DRIVER DOWN
 * banner above the cards, because every `building` card below it is then suspect.
 */
export function renderFleet(
  statuses: FeatureStatus[],
  now = new Date().toISOString(),
  chiefCost: ChiefCostByFeature = new Map(),
  drivers: DriverHealth[] = [],
): string {
  const driverLine = drivers.length > 0 ? trunc(renderDrivers(drivers), WIDTH) : null;
  if (statuses.length === 0) return ["fleet · (no features)", ...(driverLine ? [driverLine] : [])].join("\n");

  const grand = statuses.reduce((sum, f) => sum + featureTotal(f, chiefCost), 0);
  const active = statuses.filter((f) => f.feature.state !== "abandoned");
  const abandoned = statuses.length - active.length;

  const lines: string[] = [`fleet · ${money(grand)} total`];
  if (driverLine) lines.push(driverLine);
  const stale = drivers.filter((d) => d.stale);
  if (stale.length > 0) lines.push(`⚠ DRIVER DOWN? in-flight work`, `  will NOT advance — restart`);
  lines.push("");

  for (const f of active) {
    lines.push(`● ${trunc(f.feature.id, WIDTH - 2)}`);

    // Budget-park alert (ADR 0026) — highlighted at the top of the card so an overspend that needs
    // a decision (raise / ship-partial / abandon) is the first thing the eye lands on.
    const parked = f.sessions.find((s) => s.session.budgetExceededUsd !== null);
    if (parked) {
      const bud = f.feature.budgetUsd !== null ? `/${money(f.feature.budgetUsd)}` : "";
      lines.push(`  ⚠ BUDGET ${money(parked.session.budgetExceededUsd!)}${bud}`);
      lines.push(`  raise / ship / abandon`);
    }

    // Lead session: the one with a PR (the reviewable unit), else the first. Its state is the
    // most informative, rendered in owner language (AGENT-52: `review` means "awaiting YOUR
    // review", not "the reviewer is reviewing") — falls back to the feature state.
    const lead = f.sessions.find((s) => s.session.prNumber != null) ?? f.sessions[0];
    let stateLine = `  ${lead ? sessionStateLabel(lead.session.state) : f.feature.state}`;
    if (lead?.session.prNumber != null) stateLine += ` · PR #${lead.session.prNumber}`;
    if (lead?.session.locEstimate != null) stateLine += ` · ~${lead.session.locEstimate}L`;
    lines.push(trunc(stateLine, WIDTH));

    let done = 0;
    let failed = 0;
    let esc = 0;
    for (const s of f.sessions) {
      done += s.readout.reachedReady;
      failed += s.readout.failed;
      esc += s.readout.escalated;
    }
    lines.push(`  ✓${done} ✗${failed} ⚠${esc} · ${money(featureTotal(f, chiefCost))}`);
    lines.push(RULE);
  }

  if (abandoned > 0) lines.push(`  …${abandoned} abandoned (hidden)`);
  lines.push(`updated ${now.slice(11, 19)}`); // HH:MM:SS — confirms the watch pane is live

  return lines.join("\n");
}

if (import.meta.main) {
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  const dispatch = dbPath ? new DispatchRepository(dbPath) : new DispatchRepository();
  const runtime = dbPath ? new RuntimeRepository(dbPath) : new RuntimeRepository();
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
    console.log(renderFleet(statuses, undefined, chiefCost, assessHeartbeats(runtime.listHeartbeats())));
  } finally {
    plan.close();
    dispatch.close();
    runtime.close();
  }
}
