// The dispatch loop daemon (the service-layer orchestrator, AGENT-19).
//
// Reads the registry, drives each dispatch through build → review → ready, persists
// every transition via the repository (it holds no SQL — it calls repo methods), and
// resumes incomplete work on restart. The legs are an injected dependency so the
// orchestration is unit-testable without spawning `opencode serve`; the real legs are
// the default. The wake is external (ADR 0004) — an escalated dispatch is parked here,
// not auto-run, until something rewakes it to `building`.
//
// Run:  bun run src/dispatch/daemon.ts   (needs the gateway up + env)

import { estimateCost } from "./cost";
import { dispatchBranch, runBuildLeg, type BuildResult, type Issue } from "./legs/build";
import { runReviewLeg, type ReviewResult, type ReviewTarget } from "./legs/review";
import { loadConfig, type SubstrateConfig } from "../config";
import { DispatchRepository, TRANSITIONS, type Dispatch } from "../substrate/dispatch";

/** The legs the daemon drives — injected so the orchestration is testable with fakes. */
export interface DispatchLegs {
  build(issue: Issue, config: SubstrateConfig): Promise<BuildResult>;
  review(target: ReviewTarget, config: SubstrateConfig): Promise<ReviewResult>;
}

const defaultLegs: DispatchLegs = { build: runBuildLeg, review: runReviewLeg };

// Extract the PR number from a PR url (…/pull/41 → 41), or null if absent/unparseable.
function prNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const n = Number(prUrl.split("/").pop());
  return Number.isInteger(n) ? n : null;
}

export class DispatchDaemon {
  private running = false;

  constructor(
    private readonly repo: DispatchRepository,
    private readonly config: SubstrateConfig,
    private readonly legs: DispatchLegs = defaultLegs,
  ) {}

  /**
   * Process the current backlog once: every drivable incomplete dispatch (queued /
   * building / review). Parked states (escalated, awaiting rewake; amending, the #34
   * leg) are skipped. A failing dispatch is marked failed and does not stop the others.
   * Returns the count actually driven (parked/skipped don't count) — so the poll loop
   * knows whether to sleep.
   */
  async runOnce(): Promise<number> {
    // Oldest first (resumeIncomplete is newest-first), so older work isn't starved.
    const backlog = this.repo.resumeIncomplete().reverse();
    let driven = 0;
    for (const dispatch of backlog) {
      if (dispatch.state === "escalated" || dispatch.state === "amending") continue;
      try {
        await this.step(dispatch);
      } catch (err) {
        this.fail(dispatch.id, err);
      }
      driven++;
    }
    return driven;
  }

  /** Poll the registry, draining the backlog; sleep `pollMs` when there's nothing to do. */
  async run(pollMs = 5000): Promise<void> {
    this.running = true;
    while (this.running) {
      const driven = await this.runOnce();
      if (driven === 0) await Bun.sleep(pollMs);
    }
  }

  /** Stop the poll loop after the current pass. */
  stop(): void {
    this.running = false;
  }

  /** Drive one dispatch from its current state to its next stop. */
  async step(dispatch: Dispatch): Promise<void> {
    switch (dispatch.state) {
      case "queued":
        this.repo.transition(dispatch.id, "building");
        await this.build(dispatch.id);
        return;
      case "building": // resume: the build was interrupted — re-run it
        await this.build(dispatch.id);
        return;
      case "review": // resume: the PR exists, re-run the review
        await this.review(dispatch.id);
        return;
      default: // amending (#34), escalated (parked), done/failed (terminal) — nothing
        return;
    }
  }

  // Run the build leg, record its instrument fields, then either fail (no change) or
  // advance to review and continue.
  private async build(id: string): Promise<void> {
    const dispatch = this.require(id);
    const issue: Issue = { id: dispatch.issueId, title: dispatch.title, body: dispatch.spec };

    const result = await this.legs.build(issue, this.config);
    this.repo.setSessions(id, { buildSessionId: result.buildSessionId });
    this.repo.setRoute(id, result.route);
    this.repo.setCost(id, "build", estimateCost(result.route, result.tokens.input, result.tokens.output));

    if (!result.changed || !result.prUrl) {
      this.repo.transition(id, "failed");
      return;
    }
    this.repo.setPr(id, result.prUrl);
    this.repo.transition(id, "review");
    await this.review(id, result.branch);
  }

  // Run the review leg and mark the dispatch ready (done). The amend cycle (#34) will
  // insert review → amending here when the review raises blocking findings.
  private async review(id: string, branch?: string): Promise<void> {
    const dispatch = this.require(id);
    const pr = prNumber(dispatch.prUrl);
    if (pr === null) throw new Error(`dispatch ${id} is in review with no PR url`);

    const target: ReviewTarget = { pr, branch: branch ?? dispatch.branch };
    const result = await this.legs.review(target, this.config);
    this.repo.setSessions(id, { reviewSessionId: result.reviewSessionId });
    this.repo.setCost(id, "review", estimateCost(result.route, result.tokens.input, result.tokens.output));
    this.repo.transition(id, "done");
  }

  // Mark a dispatch failed (if the graph allows it from its current state) and log the
  // cause. Keeps one bad dispatch from stopping the loop.
  private fail(id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const current = this.repo.get(id);
    if (current && TRANSITIONS[current.state].includes("failed")) {
      this.repo.transition(id, "failed");
    }
    console.error(`dispatch ${id} failed: ${message}`);
  }

  private require(id: string): Dispatch {
    const dispatch = this.repo.get(id);
    if (!dispatch) throw new Error(`no dispatch ${id}`);
    return dispatch;
  }
}

export { dispatchBranch };

if (import.meta.main) {
  const config = await loadConfig();
  const daemon = new DispatchDaemon(new DispatchRepository(), config);
  await daemon.run();
}
