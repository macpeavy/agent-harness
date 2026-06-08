// The terminal reaper (the service-layer janitor, ADR 0009/0019) — sweeps the registry for
// dead dispatches and reaps the resources they leave behind: abandoned OpenCode sessions
// and dangling remote branches. Worktrees are already reaped per-leg; this handles the two
// that accumulate.
//
// A global sweep, not inline on the build loop: it's decoupled, safe to re-run (idempotent
// deletes), and skips already-reaped rows (the `reapedAt` stamp). It binds plan + registry
// (it needs the plan to know which dispatch is still a chunk's *current* attempt) and does
// I/O through injected deps, so it's unit-testable without an OpenCode serve or a real git.
//
// Policy (owner-set):
//   - done    → reap the build/review sessions (cost is already captured in the registry);
//               the branch is the owner's, cleaned by their merge --delete-branch.
//   - failed  → reap the abandoned branch; KEEP the session (debug a failure).
//   - orphaned superseded attempt (escalated, replaced by a re-dispatch — no chunk points
//               at it any more) → reap the abandoned branch; KEEP the session (debug).
//   - anything still live (current + in-flight/escalated-awaiting) → left alone.

import { DispatchRepository, type Dispatch } from "../substrate/dispatch";
import { PlanRepository } from "../substrate/plan";

/** The I/O the reaper performs, injected so the sweep is testable with fakes. Both must be
 *  idempotent — a re-run (or a resource already gone) is a no-op, not an error. */
export interface ReapDeps {
  deleteSession(sessionID: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
}

/** What a sweep cleaned. */
export interface ReapResult {
  dispatchesReaped: number;
  sessionsReaped: number;
  branchesReaped: number;
}

export class Reaper {
  constructor(
    private readonly plan: PlanRepository,
    private readonly dispatch: DispatchRepository,
    private readonly deps: ReapDeps,
  ) {}

  /** One sweep over the whole registry. Returns what it reaped. */
  async reap(): Promise<ReapResult> {
    // The dispatch ids that are still some chunk's current attempt — anything else in a
    // non-terminal state is an orphaned (superseded) re-dispatch attempt.
    const current = new Set(
      this.plan.listAllChunks().map((c) => c.dispatchId).filter((id): id is string => id !== null),
    );

    const result: ReapResult = { dispatchesReaped: 0, sessionsReaped: 0, branchesReaped: 0 };

    for (const d of this.dispatch.list()) {
      if (d.reapedAt) continue; // already swept

      if (d.state === "done") {
        result.sessionsReaped += await this.reapSessions(d);
      } else if (d.state === "failed") {
        await this.deps.deleteBranch(d.branch);
        result.branchesReaped++;
      } else if (!current.has(d.id)) {
        // Orphaned superseded attempt — the chief re-dispatched, this one is abandoned.
        await this.deps.deleteBranch(d.branch);
        result.branchesReaped++;
      } else {
        continue; // still live — don't stamp, don't reap
      }

      this.dispatch.markReaped(d.id);
      result.dispatchesReaped++;
    }

    return result;
  }

  // Delete a done dispatch's linked sessions; returns how many it deleted.
  private async reapSessions(d: Dispatch): Promise<number> {
    let n = 0;
    for (const sessionID of [d.buildSessionId, d.reviewSessionId]) {
      if (!sessionID) continue;
      await this.deps.deleteSession(sessionID);
      n++;
    }
    return n;
  }
}
