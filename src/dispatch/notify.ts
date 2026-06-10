// The notify pass (ADR 0024) — the deterministic, no-model push that runs each session-loop
// tick after recordOutcomes. Asymmetric by actor: a session entering `needs-attention` wakes
// the CHIEF (routing a parked chunk is chief work — promptAsync into its registered session);
// a session entering `review` notifies the OWNER (merging is owner work — the Notifier seam,
// default console). Exactly-once per transition via the session's `signaled_at` stamp: the
// pass selects signalling-state sessions with `signaled_at IS NULL`, fires, stamps; every
// state transition clears the stamp, so a re-park re-signals. A failed push is swallowed and
// left un-stamped (retried next tick; a later chief launch picks it up) — push is an
// accelerator on top of the durable state + `status` pull, never the system of record.

import { OpencodeClient } from "../opencode/client";
import type { PlanRepository, Session } from "../substrate/plan";
import type { ChiefRegistration } from "../substrate/runtime";
import type { FeatureStatus, PlanDispatchService } from "./plan-dispatch";

/** What the owner needs to act on a review-ready session — go merge, no `status` round-trip. */
export interface ReviewReadyNotice {
  sessionId: string;
  featureId: string;
  featureTitle: string;
  prNumber: number | null;
  prUrl: string | null;
  chunkCount: number;
  costUsd: number;
}

/** What the chief needs to start routing a needs-attention session — the parked chunks with
 *  reasons, and the routing verbs. It may still call `status` for full context. */
export interface NeedsAttentionNotice {
  sessionId: string;
  featureId: string;
  featureTitle: string;
  parked: { chunkId: string; surface: string; reason: string | null }[];
  /** Set when the park is a BUDGET park (ADR 0026) — the owner raises the budget; the chief
   *  relays rather than routes. Null for a chunk-failure park. */
  budgetExceededUsd: number | null;
  verbs: string[];
}

/** The owner channel (ADR 0024) — pluggable; the default is the console line the owner
 *  already watches in the fleet's logs pane (GitHub itself also notifies on the open PR). */
export interface Notifier {
  reviewReady(notice: ReviewReadyNotice): void | Promise<void>;
}

/** The default owner channel: one console line per review-ready session. */
export class ConsoleNotifier implements Notifier {
  reviewReady(n: ReviewReadyNotice): void {
    const pr = n.prUrl ?? (n.prNumber !== null ? `PR #${n.prNumber}` : "no PR linked");
    console.warn(
      `session ${n.sessionId} → review: "${n.featureTitle}" is built (${n.chunkCount} chunk(s), ` +
        `$${n.costUsd.toFixed(4)}) — review + merge ${pr}`,
    );
  }
}

/** Wake the chief's session with a payload — injected so the pass is testable without a
 *  live OpenCode server. The default fires `promptAsync` at the registered address. */
export type ChiefWake = (target: { baseUrl: string; sessionId: string }, prompt: string) => Promise<void>;

const defaultChiefWake: ChiefWake = (target, prompt) =>
  new OpencodeClient(target.baseUrl).promptAsync(target.sessionId, prompt);

/** The slice of the runtime context the pass needs — where the live chief can be addressed. */
export interface ChiefDirectory {
  getChief(): ChiefRegistration | null;
}

/** Render the chief's wake prompt: what happened + the self-contained payload + the verbs. */
export function chiefWakePrompt(notice: NeedsAttentionNotice): string {
  const what = notice.budgetExceededUsd !== null ? "is budget-parked" : "has parked chunk(s) to route";
  return (
    `[substrate notify] Session ${notice.sessionId} of feature "${notice.featureTitle}" ` +
    `entered needs-attention — it ${what}.\n\n` +
    `${JSON.stringify(notice, null, 2)}\n\n` +
    `Route it (${notice.verbs.join(" / ")}); call \`status\` on feature ${notice.featureId} for full context. ` +
    `A budget park is the owner's call (raise_budget / ship what's built / abandon) — relay it.`
  );
}

/**
 * One notify sweep (ADR 0024) — run by the session loop after the per-session advance.
 * Returns the number of signals successfully fired (stamped), so the loop counts a fired
 * signal as real progress. Per-session failures are contained: a failed wake logs once per
 * session per process and leaves the stamp clear for the next tick.
 */
export class NotifyPass {
  // Sessions whose failed chief push was already logged this process — keeps the every-tick
  // retry from spamming the log while no chief is registered (the retry itself is by design).
  private readonly loggedMisses = new Set<string>();

  constructor(
    private readonly plan: PlanRepository,
    private readonly service: PlanDispatchService,
    private readonly chiefs: ChiefDirectory,
    private readonly notifier: Notifier = new ConsoleNotifier(),
    private readonly wake: ChiefWake = defaultChiefWake,
  ) {}

  async runOnce(): Promise<number> {
    let fired = 0;
    for (const session of this.plan.listUnsignaledSessions(["needs-attention", "review"])) {
      const ok =
        session.state === "needs-attention" ? await this.pushChief(session) : await this.notifyOwner(session);
      if (ok) {
        this.plan.stampSignaled(session.id);
        this.loggedMisses.delete(session.id); // a later failure on a NEW transition logs again
        fired++;
      }
    }
    return fired;
  }

  // Wake the registered chief with the parked-chunk payload. False = no live chief / the
  // push failed — swallowed (the durable state is the floor), un-stamped so a later tick or
  // a later chief launch picks it up.
  private async pushChief(session: Session): Promise<boolean> {
    const notice = this.needsAttentionNotice(session);
    if (!notice) return false; // feature row missing — leave for the tick error surface

    // Ambient owner awareness (ADR 0024 open question, lean yes): one console line so the
    // owner sees the chief was handed work, without being asked to act.
    const chief = this.chiefs.getChief();
    if (!chief) {
      this.logMissOnce(session.id, `no chief registered — session ${session.id} waits in needs-attention (status/pull still works)`);
      return false;
    }
    try {
      await this.wake({ baseUrl: chief.baseUrl, sessionId: chief.sessionId }, chiefWakePrompt(notice));
      console.warn(
        `session ${session.id} → needs-attention: woke the chief (${notice.parked.length} parked chunk(s)` +
          `${notice.budgetExceededUsd !== null ? ", budget-parked" : ""})`,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logMissOnce(session.id, `chief wake failed for session ${session.id} (stale registration?): ${message}`);
      return false;
    }
  }

  // Notify the owner that a session's PR is ready. False only if the notifier threw —
  // un-stamped, retried next tick (at-least-once over silent loss).
  private async notifyOwner(session: Session): Promise<boolean> {
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) return false;
    const status = this.service.status(feature.id);
    const chunkCount = this.sessionStatus(status, session.id)?.chunks.length ?? 0;
    try {
      await this.notifier.reviewReady({
        sessionId: session.id,
        featureId: feature.id,
        featureTitle: feature.title,
        prNumber: session.prNumber,
        prUrl: session.prUrl,
        chunkCount,
        costUsd: status.cost.buildUsd + status.cost.reviewUsd + status.cost.amendUsd,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logMissOnce(session.id, `owner notify failed for session ${session.id}: ${message}`);
      return false;
    }
  }

  // Assemble the chief's payload from the cross-context status read (the service joins the
  // plan and the registry; the pass holds no SQL and reads no dispatch rows itself).
  private needsAttentionNotice(session: Session): NeedsAttentionNotice | null {
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) return null;
    const status = this.service.status(feature.id);
    const sessionStatus = this.sessionStatus(status, session.id);

    // Escalations carry the recorded reason; chunks parked without a live escalation row
    // (e.g. terminal-failed) still surface by their chunk state.
    const escalationByChunk = new Map((sessionStatus?.escalations ?? []).map((e) => [e.chunkId, e]));
    const parked = (sessionStatus?.chunks ?? [])
      .filter((c) => c.state === "escalated" || c.state === "failed")
      .map((c) => ({
        chunkId: c.id,
        surface: c.surface,
        reason: escalationByChunk.get(c.id)?.reason ?? escalationByChunk.get(c.id)?.kind ?? c.state,
      }));

    return {
      sessionId: session.id,
      featureId: feature.id,
      featureTitle: feature.title,
      parked,
      budgetExceededUsd: session.budgetExceededUsd,
      verbs: ["redecompose", "promote", "address"],
    };
  }

  private sessionStatus(status: FeatureStatus, sessionId: string) {
    return status.sessions.find((s) => s.session.id === sessionId) ?? null;
  }

  private logMissOnce(sessionId: string, message: string): void {
    if (this.loggedMisses.has(sessionId)) return;
    this.loggedMisses.add(sessionId);
    console.warn(`notify: ${message}`);
  }
}
