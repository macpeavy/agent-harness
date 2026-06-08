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
import { runAmendLeg, type AmendResult } from "./legs/amend";
import { runMergeLeg, type MergeResult, type MergeTarget } from "./legs/merge";
import { loadConfig, type SubstrateConfig } from "../config";
import { AgentTimeoutError } from "../opencode/client";
import { DispatchRepository, type Dispatch } from "../substrate/dispatch";
import { escalateOrFail } from "./escalation";

/** The legs the daemon drives — injected so the orchestration is testable with fakes. */
export interface DispatchLegs {
  build(issue: Issue, config: SubstrateConfig, opts?: { reprompt?: string }): Promise<BuildResult>;
  review(target: ReviewTarget, config: SubstrateConfig): Promise<ReviewResult>;
  amend(target: ReviewTarget, findings: string, config: SubstrateConfig): Promise<AmendResult>;
  merge(target: MergeTarget, config: SubstrateConfig): Promise<MergeResult>;
}

// The no-op gate's re-instruction (ADR 0023 §3b): when the builder reports done but the diff is
// empty, re-prompt ONCE with this before parking — a weak model sometimes explores and declares
// victory without writing anything; a sharper second ask cheaply rescues some of those.
const NO_OP_REPROMPT =
  "You reported the task complete, but you changed no files — the diff is empty, so the work is " +
  "NOT done. Implement the change now: edit the file(s) the issue specifies, then run `git diff` " +
  "to confirm the diff is non-empty before you finish. Reading, exploring, or planning is not " +
  "completion. If the change is genuinely impossible as specified, say so explicitly instead.";

const defaultLegs: DispatchLegs = {
  build: runBuildLeg,
  review: runReviewLeg,
  amend: runAmendLeg,
  merge: runMergeLeg,
};

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
      // Both are PARKED (non-terminal but not self-driving): `escalated` awaits a rewake,
      // `done` awaits an owner-review reopen (ADR 0020 slice 4b — reopenForReview moves it to
      // `amending`, which IS driven). The daemon never auto-runs either; skipping (not
      // counting) them lets the poll loop sleep when only parked/finished work remains.
      if (dispatch.state === "escalated" || dispatch.state === "done") continue;
      try {
        await this.step(dispatch);
      } catch (err) {
        // No failure is a dead end (ADR 0023): a timeout or a leg error both escalate→park
        // (chief-visible, with a reason), never a terminal fail or an unhandled throw the loop
        // can't survive. Both route through the one escalation surface.
        if (err instanceof AgentTimeoutError) this.escalateTimeout(dispatch.id, err);
        else this.parkLegError(dispatch.id, err);
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
      case "review": // resume: the PR exists, re-enter the review/amend cycle
        await this.review(dispatch.id);
        return;
      case "amending":
        if (dispatch.pendingFindings) {
          // Reopened by owner review (ADR 0020 slice 4b): amend against the owner's findings,
          // then let the normal review cycle take over (re-review the fix, merge on clean).
          await this.ownerAmend(dispatch.id, dispatch.pendingFindings);
        } else {
          // Resume: an in-cycle amend was interrupted — re-review and continue.
          this.repo.transition(dispatch.id, "review");
          await this.review(dispatch.id);
        }
        return;
      default: // escalated (parked), done/failed (terminal) — nothing to drive
        return;
    }
  }

  // Run the build leg, record its instrument fields, then either fail (no change) or
  // advance to review and continue.
  private async build(id: string): Promise<void> {
    const dispatch = this.require(id);
    // Reconstruct the build Issue from the row, carrying the chunk's curation (surface +
    // curated skill names) so the right context pack injects (ADR 0018/0019) — and so a
    // resumed build keeps it. Null columns fall through to the build leg's standards-only
    // default. `?? undefined` keeps the optional Issue fields optional (not null).
    const issue: Issue = {
      id: dispatch.issueId,
      title: dispatch.title,
      body: dispatch.spec,
      surface: dispatch.surface ?? undefined,
      skills: dispatch.skills ?? undefined,
      tier: dispatch.tier ?? undefined,
      sessionBranch: dispatch.sessionBranch ?? undefined,
    };

    let result = await this.legs.build(issue, this.config);
    this.recordBuild(id, result);

    // No-op gate (ADR 0023 §3b): an empty diff means the builder reported done without writing
    // anything (the false-success no-op). Re-prompt ONCE with a sharper instruction and rebuild;
    // if it's STILL empty, park it (reason `no-op`) — never terminal-fail, never loop.
    if (!result.changed) {
      result = await this.legs.build(issue, this.config, { reprompt: NO_OP_REPROMPT });
      this.recordBuild(id, result);
      if (!result.changed) {
        const { reason } = escalateOrFail(this.repo, id, { kind: "no-op" });
        console.error(`dispatch ${id} escalated (${reason}): builder changed nothing after a re-prompt`);
        return;
      }
    }
    this.repo.transition(id, "review");
    await this.review(id, result.branch);
  }

  // Record a build attempt's instrument fields. Cost accumulates (the no-op gate runs the leg
  // twice); route + session id reflect the latest attempt.
  private recordBuild(id: string, result: BuildResult): void {
    this.repo.setSessions(id, { buildSessionId: result.buildSessionId });
    this.repo.setRoute(id, result.route);
    this.repo.setCost(id, "build", estimateCost(result.route, result.tokens.input, result.tokens.output));
  }

  // The review → amend cycle (ADR 0008): review; if clean, ready (done); if blocking,
  // amend and re-review, up to the cap; on cap-exceeded, escalate (parked). A nit-only
  // review is `clean` and does not burn a round (the reviewer ranks severity).
  private async review(id: string, branch?: string): Promise<void> {
    while (true) {
      const dispatch = this.require(id);
      const target: ReviewTarget = {
        branch: branch ?? dispatch.branch,
        sessionBranch: dispatch.sessionBranch ?? undefined,
      };

      const result = await this.legs.review(target, this.config);
      this.repo.setSessions(id, { reviewSessionId: result.reviewSessionId });
      this.repo.setCost(id, "review", estimateCost(result.route, result.tokens.input, result.tokens.output));

      if (result.verdict === "clean") {
        // Clean review → squash-merge the chunk into session-main (ADR 0020), then done.
        await this.merge(id, target.branch);
        this.repo.transition(id, "done");
        return;
      }
      if (dispatch.amendRounds >= this.config.amendCap) {
        // Cap exceeded — not a retry-harder signal but an under-decomposition one
        // (ADR 0008/0023 row 4). Park, to be rewoken on resolution.
        escalateOrFail(this.repo, id, { kind: "amend-cap" });
        return;
      }
      this.repo.transition(id, "amending");
      const amended = await this.amend(id, target, result.review);
      if (!amended) {
        // The builder couldn't change anything against the findings — re-reviewing
        // identical code would just burn rounds. It's stuck; escalate now (row 4).
        escalateOrFail(this.repo, id, { kind: "amend-cap" });
        return;
      }
      this.repo.transition(id, "review");
    }
  }

  // One amend round: re-run the builder against the findings, record the round + cost.
  // Returns whether the amend actually changed anything.
  private async amend(id: string, target: ReviewTarget, findings: string): Promise<boolean> {
    const result = await this.legs.amend(target, findings, this.config);
    this.repo.setRoute(id, result.route);
    this.repo.setCost(id, "amend", estimateCost(result.route, result.tokens.input, result.tokens.output));
    this.repo.incrementAmendRound(id);
    return result.changed;
  }

  // An owner-review reopen (ADR 0020 slice 4b): the dispatch is already `amending` with the
  // owner's PR findings stashed on it. Amend against them (re-using the chunk's branch, which
  // still exists on origin — the prior content is already in session-main, so the re-merge
  // carries just the fix delta), clear the findings, then hand to the normal review cycle:
  // a clean re-review squash-merges the fix into session-main and the PR updates. If the
  // builder can't action the owner's note, escalate `attended` — it needs the chief/owner,
  // not another cheap round.
  private async ownerAmend(id: string, findings: string): Promise<void> {
    const dispatch = this.require(id);
    const target: ReviewTarget = {
      branch: dispatch.branch,
      sessionBranch: dispatch.sessionBranch ?? undefined,
    };
    const amended = await this.amend(id, target, findings);
    this.repo.clearPendingFindings(id);
    if (!amended) {
      escalateOrFail(this.repo, id, { kind: "owner-note" }); // row 5 → park to attended
      return;
    }
    this.repo.transition(id, "review");
    await this.review(id);
  }

  // Squash-merge a cleanly-reviewed chunk into its session-main branch (ADR 0020). The
  // session-main branch rides the dispatch row, so the daemon stays plan-agnostic. A
  // dispatch with no sessionBranch (legacy build-off-main) has nothing to merge into.
  private async merge(id: string, branch: string): Promise<void> {
    const dispatch = this.require(id);
    if (!dispatch.sessionBranch) return;
    await this.legs.merge({ branch, sessionBranch: dispatch.sessionBranch, title: dispatch.title }, this.config);
  }

  // A model turn timed out (ADR 0023 row 3): park it for the chief through the central surface —
  // it can tier-promote or re-decompose. escalateOrFail falls back to terminal only if the state
  // has no escalate edge (it shouldn't — a timeout happens mid build/review/amend).
  private escalateTimeout(id: string, err: AgentTimeoutError): void {
    escalateOrFail(this.repo, id, { kind: "timeout", message: err.message });
    console.error(`dispatch ${id} escalated (timeout): ${err.message}`);
  }

  // A leg threw (ADR 0023 row 2): park it (reason `error`) through the central surface, not a
  // terminal fail — a worktree/install/agent error is recoverable (redecompose / promote / retry).
  // Keeps one bad dispatch from stopping the loop.
  private parkLegError(id: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    escalateOrFail(this.repo, id, { kind: "error", message });
    console.error(`dispatch ${id} escalated (error): ${message}`);
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
  // migrate: false — `make up` co-launches this with the session-loop, so migration runs once
  // up front (`make migrate`); migrating here too would race the other process (ADR 0016).
  const daemon = new DispatchDaemon(new DispatchRepository(undefined, { migrate: false }), config);
  await daemon.run();
}
