// The session loop (the service-layer session tick, ADR 0020 slice 2b) — the deterministic
// mechanism that drives an APPROVED feature's sessions into their session-main PRs. No model,
// no reasoning (that escalates to the chief): pure state.
//
// Per tick, for each session of a feature the owner has approved (feature ready/building):
//   1. open session-main + the one PR if it isn't open yet (the session-open leg), and link it;
//   2. materialise the session's ready chunks (service.dispatchReady) — the daemon then drives
//      each build → review → squash-merge into session-main (slice 2a);
//   3. flow landed outcomes back (service.recordOutcomes), which advances the DAG (newly-ready
//      chunks dispatch next tick) and completes the session → feature when all chunks land.
//
// It only touches APPROVED features — a feature still in `planning` is skipped, so the owner
// gate (the chief's `approve`/`dispatch`) holds. The session-open leg is injected so the loop
// is unit-testable without real git/gh. Runs alongside the dispatch daemon (which drives the
// individual builds); this loop advances the plan.

import { loadConfig, type SubstrateConfig } from "../config";
import { PlanRepository } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanDispatchService } from "./plan-dispatch";
import { runSessionOpenLeg, type SessionOpenResult } from "./legs/session-open";
import { ledgerPath, readSpendLedger, spendInWindow } from "./litellm-spend";
import { isOverBudget } from "./budget";
import type { ReconcileCost } from "./daemon";

/** The session-level legs the loop drives — injected so the tick is testable with fakes. */
export interface SessionLegs {
  open(sessionId: string, title: string, config: SubstrateConfig): Promise<SessionOpenResult>;
}

const defaultSessionLegs: SessionLegs = {
  open: runSessionOpenLeg,
};

export class SessionLoop {
  private running = false;
  private readonly chiefSpend: ReconcileCost;

  constructor(
    private readonly plan: PlanRepository,
    private readonly service: PlanDispatchService,
    private readonly config: SubstrateConfig,
    private readonly legs: SessionLegs = defaultSessionLegs,
    // The chief's real spend in a window (ADR 0026 decision 2 budget guard) — same ledger reader
    // the daemon uses for per-leg cost. Injected so the loop is testable without a live ledger.
    chiefSpend?: ReconcileCost,
  ) {
    this.chiefSpend =
      chiefSpend ?? ((route, start, end) => spendInWindow(readSpendLedger(ledgerPath(config.repoPath)), route, start, end));
  }

  /**
   * One tick over every session. Opens + advances the sessions of approved features; skips only
   * terminal sessions and sessions of un-approved (planning) features. Returns the count of
   * sessions that made REAL progress this tick (opened, flowed an outcome, materialised a
   * dispatch, or changed state) — NOT the count processed (AGENT-38). A tick that merely
   * re-checks parked/in-flight sessions and changes nothing returns 0, so the poll loop sleeps
   * instead of pegging a core. A `needs-attention` session is still re-checked every tick (not
   * skipped) so it resumes the moment the chief routes its parked chunk — it just doesn't COUNT
   * as progress while nothing has changed.
   */
  async runOnce(): Promise<number> {
    // Enforce the budget guard FIRST (ADR 0026 decision 2) — prevent-before-spend: a feature
    // already over budget parks its building sessions now, so this tick's advance dispatches no
    // further chunks (dispatchReady is guarded for a budget-parked session).
    let advanced = this.checkBudgets();
    for (const session of this.plan.listAllSessions()) {
      if (session.state === "done" || session.state === "failed" || session.state === "abandoned") continue;
      const feature = this.plan.getFeature(session.featureId);
      if (!feature || feature.state === "planning") continue; // not yet approved — the owner gate

      // One session's throw must NEVER exit the loop process (the recurring exit-1 crash). Catch
      // per session: record the error (so the chief sees it in status) and CONTINUE — the others
      // advance, and this one retries next tick (advance is idempotent, so a transient failure
      // self-heals). A clean tick clears any prior error.
      try {
        const progressed = await this.advance(session.id, feature.title, session.branch === null);
        if (session.lastError !== null) this.plan.clearSessionError(session.id);
        if (progressed) advanced++;
      } catch (err) {
        // Record + continue, but do NOT count it as progress — a persistently-throwing session
        // (e.g. session-open failing) must let the loop sleep and retry at poll cadence, not
        // hot-loop on the error (that's the CPU peg in a different guise).
        const message = err instanceof Error ? err.message : String(err);
        console.error(`session-loop: session ${session.id} tick failed: ${message}`);
        this.plan.setSessionError(session.id, message);
      }
    }
    return advanced;
  }

  /**
   * The runtime budget guard (ADR 0026 decision 2): for each building feature with a budget, sum
   * its REAL running total — legs (the daemon's recorded per-leg cost) + the chief (route=chief
   * over the feature's window, from the ledger) — and park (NOT hard-kill) its building sessions
   * when the total crosses the budget. Work already merged into session-main is preserved; only
   * new dispatch stops. Returns the count of sessions parked this tick (0 = nothing tripped).
   */
  private checkBudgets(): number {
    let parked = 0;
    for (const feature of this.plan.listAllFeatures()) {
      if (feature.state !== "building" || feature.budgetUsd === null) continue;
      const { cost } = this.service.status(feature.id);
      const legs = cost.buildUsd + cost.reviewUsd + cost.amendUsd;
      const chief = this.chiefSpend("chief", cost.window.start, cost.window.end);
      const total = legs + chief;
      if (!isOverBudget(total, feature.budgetUsd)) continue;
      const sessions = this.service.parkOverBudget(feature.id, total);
      if (sessions.length > 0) {
        parked += sessions.length;
        console.warn(
          `session-loop: feature ${feature.id} over budget ($${total.toFixed(4)} > $${feature.budgetUsd.toFixed(4)}) — ` +
            `parked ${sessions.length} session(s) (${sessions.join(", ")}); raise the budget to resume (work preserved)`,
        );
      }
    }
    return parked;
  }

  /** Poll, advancing approved sessions; sleep `pollMs` when there's nothing to do. */
  async run(pollMs = 5000): Promise<void> {
    this.running = true;
    while (this.running) {
      const advanced = await this.runOnce();
      if (advanced === 0) await Bun.sleep(pollMs);
    }
  }

  /** Stop the poll loop after the current tick. */
  stop(): void {
    this.running = false;
  }

  // Open session-main if needed, then reap landed outcomes and materialise ready chunks. Returns
  // whether this tick made REAL progress (AGENT-38) — so a no-op pass over a parked/in-flight
  // session doesn't keep the poll loop awake. Progress = opened the session, flowed an outcome,
  // materialised a dispatch, or changed the session's state (e.g. building→needs-attention, or
  // needs-attention→building when the chief routes a parked chunk).
  private async advance(sessionId: string, title: string, needsOpen: boolean): Promise<boolean> {
    let opened = false;
    if (needsOpen) {
      const links = await this.legs.open(sessionId, title, this.config);
      this.plan.linkSessionPr(sessionId, links);
      opened = true;
    }
    const stateBefore = this.plan.getSession(sessionId)?.state;
    // Reap first, then materialise: flowing landed outcomes back marks finished chunks 'done',
    // which is what unblocks their dependents — so the same tick can dispatch the newly-ready
    // ones. (Materialising first would defer each DAG step a whole extra tick.)
    const flowed = this.service.recordOutcomes(sessionId);
    // dispatchReady re-reads the session, so it sees the just-linked branch; it only
    // materialises chunks that are 'planned' with satisfied deps (idempotent across ticks).
    const materialised = this.service.dispatchReady(sessionId);
    const stateAfter = this.plan.getSession(sessionId)?.state;

    return opened || flowed.length > 0 || materialised.length > 0 || stateBefore !== stateAfter;
  }
}

if (import.meta.main) {
  const config = await loadConfig();
  // migrate: false — `make up` co-launches this with the daemon, so migration runs once up
  // front (`make migrate`); migrating here too would race the other process (ADR 0016).
  const plan = new PlanRepository(undefined, { migrate: false });
  const dispatch = new DispatchRepository(undefined, { migrate: false });
  const service = new PlanDispatchService(plan, dispatch);
  await new SessionLoop(plan, service, config).run();
}
