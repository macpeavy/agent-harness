// The notify pass (ADR 0024 + AGENT-45) — the deterministic, no-model push that runs each
// session-loop tick after recordOutcomes. Asymmetric by actor: a session entering
// `needs-attention` wakes the CHIEF (routing a parked chunk is chief work — promptAsync into
// its registered session); a session entering `review` notifies the OWNER (merging is owner
// work — the Notifier seam, default console) AND FYIs the chief (ADR 0028 — the chief is the
// owner's conversational interface; without the FYI it sits silent through build-complete,
// having told the owner it would check back); a session auto-closed to `done` (the loop
// detected the merged PR) tells the CHIEF its picture changed (the triad's third leg — the
// manual close_session suppresses this, the chief already knows). Exactly-once per transition
// via the session's `signaled_at` stamp: the pass selects signalling-state sessions with
// `signaled_at IS NULL`, fires, stamps; every state transition clears the stamp, so a re-park
// re-signals. A failed push is swallowed and left un-stamped (retried next tick; a later chief
// launch picks it up) — push is an accelerator on top of the durable state + `status` pull,
// never the system of record. The review-transition chief FYI is the one at-most-once leg:
// it rides the owner signal's stamp, so a missing chief never re-rings the owner's bell
// (ADR 0028; a chief that missed it reads the session from `status`).

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

/** What the chief needs to route a CI failure on a built session's PR — the failing checks
 *  and the head they failed on; the fix path is amend_chunk into the amend cycle. */
export interface CiFailureNotice {
  sessionId: string;
  featureId: string;
  featureTitle: string;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string;
  failedChecks: string[];
  /** The session's chunks (id + surface), so the chief can pick the amend target without a
   *  status round-trip. */
  chunks: { chunkId: string; surface: string }[];
}

/** What the chief needs to act on an owner response (AGENT-54) — the owner left a
 *  changes-requested review or new comments on an in-review session's PR; the chief routes
 *  them with address_review. */
export interface OwnerResponseNotice {
  sessionId: string;
  featureId: string;
  featureTitle: string;
  prNumber: number | null;
  prUrl: string | null;
  /** The response wave's timestamp (epoch ms) — the exactly-once key the pass stamps. */
  respondedAt: number;
}

/** What the chief needs to update its picture when a session's PR merged on GitHub and the
 *  substrate closed it (AGENT-45) — no routing, just the new state of the world. */
export interface SessionDoneNotice {
  sessionId: string;
  featureId: string;
  featureTitle: string;
  prNumber: number | null;
  prUrl: string | null;
  /** The feature's state after the close — 'done' when this was its last session. */
  featureState: string;
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

/** Render the chief's CI-failure wake: the built session's checks failed on GitHub — diagnose
 *  and route the fix into the amend cycle via amend_chunk. */
export function chiefCiFailurePrompt(notice: CiFailureNotice): string {
  const pr = notice.prUrl ?? (notice.prNumber !== null ? `PR #${notice.prNumber}` : "its PR");
  return (
    `[substrate notify] CI failed on ${pr} (session ${notice.sessionId} of feature ` +
    `"${notice.featureTitle}", head ${notice.headSha.slice(0, 9)}): ` +
    `${notice.failedChecks.join(", ")}.\n\n` +
    `${JSON.stringify(notice, null, 2)}\n\n` +
    `Diagnose which chunk owns the failure (read the check logs on the PR if needed) and route ` +
    `the fix with amend_chunk(chunkId, findings) — the builder amends, the reviewer re-reviews, ` +
    `the fix lands in session-main and the checks re-run. If the failure needs work no existing ` +
    `chunk owns, surface it to the owner instead.`
  );
}

/** Render the chief's review-ready FYI (ADR 0028): the session is built and with the owner —
 *  nothing to route, nothing to close; surface it to the owner if attended. */
export function chiefReviewReadyPrompt(notice: ReviewReadyNotice): string {
  const pr = notice.prUrl ?? (notice.prNumber !== null ? `PR #${notice.prNumber}` : "its PR");
  return (
    `[substrate notify] Session ${notice.sessionId} of feature "${notice.featureTitle}" is ` +
    `BUILT and awaiting the owner's review — ${pr} (${notice.chunkCount} chunk(s), ` +
    `$${notice.costUsd.toFixed(4)}). The owner has been notified on their channels too.\n\n` +
    `Nothing to route and nothing to close — the substrate watches the PR and will tell you ` +
    `when it merges (do NOT call close_session). If you're in an attended session, give the ` +
    `owner a one-line heads-up with the PR link; otherwise just update your picture.`
  );
}

/** Render the chief's owner-response wake (AGENT-54): the owner reviewed/commented on an
 *  in-review session's PR — read and route it with address_review, don't wait to be asked. */
export function chiefOwnerResponsePrompt(notice: OwnerResponseNotice): string {
  const pr = notice.prUrl ?? (notice.prNumber !== null ? `PR #${notice.prNumber}` : "its PR");
  return (
    `[substrate notify] The owner responded on ${pr} (session ${notice.sessionId} of feature ` +
    `"${notice.featureTitle}", in review): a changes-requested review and/or new comments.\n\n` +
    `${JSON.stringify(notice, null, 2)}\n\n` +
    `Call address_review("${notice.sessionId}") to read the review off the PR and route it ` +
    `into the amend cycle — inline comments reopen their chunk; general/unroutable notes come ` +
    `back for your judgment. Report tool errors verbatim if it fails; do not guess.`
  );
}

/** Render the chief's completion wake (AGENT-45): the PR merged, the session is closed —
 *  update the picture, don't offer to close it, route nothing. */
export function chiefDonePrompt(notice: SessionDoneNotice): string {
  const pr = notice.prUrl ?? (notice.prNumber !== null ? `PR #${notice.prNumber}` : "its PR");
  return (
    `[substrate notify] ${pr} was merged on GitHub — session ${notice.sessionId} of feature ` +
    `"${notice.featureTitle}" is closed (done); feature ${notice.featureId} is now ` +
    `${notice.featureState}. The substrate already recorded this — do NOT call close_session. ` +
    `No action needed.\n\n${JSON.stringify(notice, null, 2)}`
  );
}

/** Render the chief's wake prompt: what happened + the self-contained payload + the verbs. */
export function chiefWakePrompt(notice: NeedsAttentionNotice): string {
  const budgetParked = notice.budgetExceededUsd !== null;
  const action = budgetParked
    ? "A budget park is the owner's call (raise_budget / ship what's built / abandon) — relay it."
    : `Route it (${notice.verbs.join(" / ")}); call \`status\` on feature ${notice.featureId} for full context.`;
  return (
    `[substrate notify] Session ${notice.sessionId} of feature "${notice.featureTitle}" ` +
    `entered needs-attention — it ${budgetParked ? "is budget-parked" : "has parked chunk(s) to route"}.\n\n` +
    `${JSON.stringify(notice, null, 2)}\n\n${action}`
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
    for (const session of this.plan.listUnsignaledSessions(["needs-attention", "review", "done"])) {
      const ok =
        session.state === "needs-attention"
          ? await this.pushChief(session)
          : session.state === "review"
            ? await this.notifyOwner(session)
            : await this.pushChiefDone(session);
      if (ok) {
        this.plan.stampSignaled(session.id);
        this.loggedMisses.delete(session.id); // a later failure on a NEW transition logs again
        fired++;
      }
    }
    // The CI leg — keyed by head SHA, not session state (the session stays in `review` while
    // its checks fail, so signaled_at can't carry this; ci_signaled_sha does).
    for (const session of this.plan.listUnsignaledCiFailures()) {
      const signaledSha = await this.pushChiefCiFailure(session);
      if (signaledSha !== null) {
        this.plan.stampCiSignaled(session.id, signaledSha);
        this.loggedMisses.delete(session.id);
        fired++;
      }
    }
    // The owner-response leg (AGENT-54) — keyed by the response wave's timestamp, same shape
    // as the CI leg (the session stays in `review` while the owner reviews, so signaled_at
    // can't carry this; owner_response_signaled_at does, and a NEWER response re-arms it).
    for (const session of this.plan.listUnsignaledOwnerResponses()) {
      const signaledAt = await this.pushChiefOwnerResponse(session);
      if (signaledAt !== null) {
        this.plan.stampOwnerResponseSignaled(session.id, signaledAt);
        this.loggedMisses.delete(session.id);
        fired++;
      }
    }
    return fired;
  }

  // Wake the chief with a CI failure on a built session's PR (the CI leg). Returns the head
  // SHA that was signaled (to stamp), or null on no-chief / failed push / no payload — left
  // pending, retried next tick, picked up by a later chief launch.
  private async pushChiefCiFailure(session: Session): Promise<string | null> {
    if (session.ciFailedSha === null) return null; // raced a clear between select and push
    const chief = this.chiefs.getChief();
    if (!chief) {
      this.logMissOnce(session.id, `no chief registered — CI failure on session ${session.id} waits (status/pull still works)`);
      return null;
    }
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) return null;

    let failedChecks: string[] = [];
    try {
      failedChecks = session.ciFailedChecks === null ? [] : (JSON.parse(session.ciFailedChecks) as string[]);
    } catch {
      // A malformed record still signals — the chief can read the PR; better than silence.
    }
    const notice: CiFailureNotice = {
      sessionId: session.id,
      featureId: feature.id,
      featureTitle: feature.title,
      prNumber: session.prNumber,
      prUrl: session.prUrl,
      headSha: session.ciFailedSha,
      failedChecks,
      chunks: this.plan.listChunks(session.id).map((c) => ({ chunkId: c.id, surface: c.surface })),
    };
    try {
      await this.wake({ baseUrl: chief.baseUrl, sessionId: chief.sessionId }, chiefCiFailurePrompt(notice));
      // Ambient owner awareness, same as the needs-attention push: one console line.
      console.warn(
        `session ${session.id} CI FAILED on PR #${session.prNumber ?? "?"} (${failedChecks.join(", ") || "see PR"}) — woke the chief to route a fix`,
      );
      return session.ciFailedSha;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logMissOnce(session.id, `chief CI-failure wake failed for session ${session.id} (stale registration?): ${message}`);
      return null;
    }
  }

  // Wake the chief with an owner response on an in-review session's PR (AGENT-54). Returns
  // the wave timestamp that was signaled (to stamp), or null on no-chief / failed push —
  // left pending, retried next tick, picked up by a later chief launch.
  private async pushChiefOwnerResponse(session: Session): Promise<number | null> {
    if (session.ownerResponseAt === null) return null; // raced a clear between select and push
    const chief = this.chiefs.getChief();
    if (!chief) {
      this.logMissOnce(session.id, `no chief registered — owner response on session ${session.id} waits (address_review still works manually)`);
      return null;
    }
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) return null;
    const notice: OwnerResponseNotice = {
      sessionId: session.id,
      featureId: feature.id,
      featureTitle: feature.title,
      prNumber: session.prNumber,
      prUrl: session.prUrl,
      respondedAt: session.ownerResponseAt,
    };
    try {
      await this.wake({ baseUrl: chief.baseUrl, sessionId: chief.sessionId }, chiefOwnerResponsePrompt(notice));
      // Ambient owner awareness, same as the other pushes: one console line.
      console.warn(
        `session ${session.id}: owner responded on PR #${session.prNumber ?? "?"} — woke the chief to address the review`,
      );
      return session.ownerResponseAt;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logMissOnce(session.id, `chief owner-response wake failed for session ${session.id} (stale registration?): ${message}`);
      return null;
    }
  }

  // Wake the registered chief with the parked-chunk payload. False = no live chief / the
  // push failed — swallowed (the durable state is the floor), un-stamped so a later tick or
  // a later chief launch picks it up. The registration check comes first: with no chief up,
  // the tick shouldn't pay the cross-context status read just to throw the payload away.
  private async pushChief(session: Session): Promise<boolean> {
    const chief = this.chiefs.getChief();
    if (!chief) {
      this.logMissOnce(session.id, `no chief registered — session ${session.id} waits in needs-attention (status/pull still works)`);
      return false;
    }
    const notice = this.needsAttentionNotice(session);
    if (!notice) return false; // feature row missing — leave for the tick error surface

    try {
      await this.wake({ baseUrl: chief.baseUrl, sessionId: chief.sessionId }, chiefWakePrompt(notice));
      // Ambient owner awareness (ADR 0024 open question, lean yes): one console line so the
      // owner sees the chief was handed work, without being asked to act.
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

  // Tell the chief a session's PR merged and the session auto-closed (AGENT-45 — only the
  // substrate-detected path leaves this signal pending; a manual close_session stamps it).
  // Same degradation as pushChief: no chief / failed push → pending, picked up later.
  private async pushChiefDone(session: Session): Promise<boolean> {
    const chief = this.chiefs.getChief();
    if (!chief) {
      this.logMissOnce(session.id, `no chief registered — session ${session.id} closed (done); a later chief sees it via status`);
      return false;
    }
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) return false;
    const notice: SessionDoneNotice = {
      sessionId: session.id,
      featureId: feature.id,
      featureTitle: feature.title,
      prNumber: session.prNumber,
      prUrl: session.prUrl,
      featureState: feature.state,
    };
    try {
      await this.wake({ baseUrl: chief.baseUrl, sessionId: chief.sessionId }, chiefDonePrompt(notice));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logMissOnce(session.id, `chief done-push failed for session ${session.id} (stale registration?): ${message}`);
      return false;
    }
  }

  // Notify the owner that a session's PR is ready, then FYI the chief (ADR 0028). False only
  // if the OWNER notifier threw — un-stamped, retried next tick (at-least-once over silent
  // loss). The chief FYI is best-effort within the same signal: a missing chief or a failed
  // wake never blocks the stamp (re-firing would re-ring the owner's bell every tick), and
  // the miss is benign — a later chief sees the in-review session at the top of `status`.
  private async notifyOwner(session: Session): Promise<boolean> {
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) return false;
    const status = this.service.status(feature.id);
    const chunkCount = this.sessionStatus(status, session.id)?.chunks.length ?? 0;
    const notice: ReviewReadyNotice = {
      sessionId: session.id,
      featureId: feature.id,
      featureTitle: feature.title,
      prNumber: session.prNumber,
      prUrl: session.prUrl,
      chunkCount,
      costUsd: status.cost.buildUsd + status.cost.reviewUsd + status.cost.amendUsd,
    };
    try {
      await this.notifier.reviewReady(notice);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logMissOnce(session.id, `owner notify failed for session ${session.id}: ${message}`);
      return false;
    }
    await this.fyiChiefReviewReady(notice);
    return true;
  }

  // The chief's review-ready FYI (ADR 0028) — at-most-once, riding the owner signal's stamp.
  private async fyiChiefReviewReady(notice: ReviewReadyNotice): Promise<void> {
    const chief = this.chiefs.getChief();
    if (!chief) {
      this.logMissOnce(
        `review-fyi:${notice.sessionId}`,
        `no chief registered — session ${notice.sessionId} reached review un-announced (a later chief sees it via status)`,
      );
      return;
    }
    try {
      await this.wake({ baseUrl: chief.baseUrl, sessionId: chief.sessionId }, chiefReviewReadyPrompt(notice));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logMissOnce(
        `review-fyi:${notice.sessionId}`,
        `chief review-ready FYI failed for session ${notice.sessionId} (stale registration?): ${message}`,
      );
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
