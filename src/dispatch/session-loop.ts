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

/** The session-level legs the loop drives — injected so the tick is testable with fakes. */
export interface SessionLegs {
  open(sessionId: string, title: string, config: SubstrateConfig): Promise<SessionOpenResult>;
}

const defaultSessionLegs: SessionLegs = {
  open: runSessionOpenLeg,
};

export class SessionLoop {
  private running = false;

  constructor(
    private readonly plan: PlanRepository,
    private readonly service: PlanDispatchService,
    private readonly config: SubstrateConfig,
    private readonly legs: SessionLegs = defaultSessionLegs,
  ) {}

  /**
   * One tick over every session. Opens + advances the sessions of approved features; skips
   * terminal sessions and sessions of un-approved (planning) features. Returns the count of
   * sessions advanced — so a poll loop knows whether to sleep.
   */
  async runOnce(): Promise<number> {
    let advanced = 0;
    for (const session of this.plan.listAllSessions()) {
      if (session.state === "done" || session.state === "failed") continue;
      const feature = this.plan.getFeature(session.featureId);
      if (!feature || feature.state === "planning") continue; // not yet approved — the owner gate

      await this.advance(session.id, feature.title, session.branch === null);
      advanced++;
    }
    return advanced;
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

  // Open session-main if needed, then materialise ready chunks and reap landed outcomes.
  private async advance(sessionId: string, title: string, needsOpen: boolean): Promise<void> {
    if (needsOpen) {
      const links = await this.legs.open(sessionId, title, this.config);
      this.plan.linkSessionPr(sessionId, links);
    }
    // Reap first, then materialise: flowing landed outcomes back marks finished chunks 'done',
    // which is what unblocks their dependents — so the same tick can dispatch the newly-ready
    // ones. (Materialising first would defer each DAG step a whole extra tick.)
    this.service.recordOutcomes(sessionId);
    // dispatchReady re-reads the session, so it sees the just-linked branch; it only
    // materialises chunks that are 'planned' with satisfied deps (idempotent across ticks).
    this.service.dispatchReady(sessionId);
  }
}

if (import.meta.main) {
  const config = await loadConfig();
  const plan = new PlanRepository();
  const dispatch = new DispatchRepository();
  const service = new PlanDispatchService(plan, dispatch);
  await new SessionLoop(plan, service, config).run();
}
