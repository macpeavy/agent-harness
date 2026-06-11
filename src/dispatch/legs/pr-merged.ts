// The session-PR probe (service layer, AGENT-45 + the CI leg + AGENT-54) — what GitHub knows
// about an in-`review` session's PR that the substrate can't see from DB state: did the owner
// merge it, did its checks fail, and did the owner RESPOND (a changes-requested/commented
// review, or a Conversation-tab comment)? One `gh pr view` per call reads all three; the
// session loop owns the cadence. On merge the loop closes the session; on a concluded check
// failure it records the failing head so the notify pass can wake the chief to route a fix
// (amend_chunk); on an owner response it records the wave's timestamp so the notify pass can
// wake the chief to run address_review.

import { $ } from "bun";
import type { SubstrateConfig } from "../../config";
import { resolveBotLogin } from "./gh-identity";

/** What one probe of the session PR concluded. */
export interface PrProbe {
  /** The owner merged the PR. A closed-but-unmerged PR is false — rejecting a session PR
   *  is the abandon CLI's path, not a completion. */
  merged: boolean;
  /** The PR's current head commit, when reported. */
  headSha: string | null;
  /** Names of checks that CONCLUDED in failure on that head. Pending/queued checks are not
   *  failures yet — the next probe sees their conclusion. Empty = green, pending, or no CI. */
  failedChecks: string[];
  /** The latest owner review activity on the PR (epoch ms): a changes-requested review, a
   *  commented review with a note, or an issue comment — the bot's own identity excluded.
   *  Null = no owner response (AGENT-54). */
  ownerRespondedAt: number | null;
}

// The rollup item shapes gh returns: CheckRun (GitHub Actions et al) carries name +
// status/conclusion; StatusContext (commit statuses) carries context + state.
interface RollupItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

// The review/comment slices `gh pr view --json reviews,comments` returns.
interface RawPrReview {
  author?: { login?: string } | null;
  state?: string;
  body?: string;
  submittedAt?: string;
}
interface RawIssueComment {
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
}

/**
 * The check names that concluded in failure, from a `statusCheckRollup` payload. Pure, so
 * the conclusion taxonomy is unit-testable: a CheckRun fails on FAILURE/TIMED_OUT (CANCELLED
 * is excluded — it usually means a superseding push, not a verdict); a StatusContext fails
 * on FAILURE/ERROR. Anything pending or successful is not a failure.
 */
export function failedChecksFrom(rollup: RollupItem[] | null | undefined): string[] {
  const failed: string[] = [];
  for (const item of rollup ?? []) {
    const name = item.name ?? item.context ?? "unnamed check";
    if (item.conclusion === "FAILURE" || item.conclusion === "TIMED_OUT") failed.push(name);
    else if (item.state === "FAILURE" || item.state === "ERROR") failed.push(name);
  }
  return failed;
}

/**
 * The latest owner response on the PR, in epoch ms — or null if there is none (AGENT-54).
 * Pure, so the response taxonomy is unit-testable. Counts as a response:
 *   - a CHANGES_REQUESTED review (body or not — the verdict itself is the feedback);
 *   - a COMMENTED (or DISMISSED) review with a non-empty body;
 *   - an issue comment with a non-empty body (the Conversation tab).
 * Does NOT count: an APPROVED review (that's the merge path, not amend feedback), an
 * empty-bodied comment, or anything authored by the bot's own login.
 */
export function latestOwnerResponseFrom(
  reviews: RawPrReview[] | null | undefined,
  comments: RawIssueComment[] | null | undefined,
  botLogin: string | null,
): number | null {
  let latest: number | null = null;
  const consider = (atIso: string | undefined): void => {
    const at = atIso ? Date.parse(atIso) : NaN;
    if (Number.isNaN(at)) return;
    if (latest === null || at > latest) latest = at;
  };

  for (const r of reviews ?? []) {
    if (botLogin !== null && r.author?.login === botLogin) continue;
    if (r.state === "APPROVED") continue;
    if (r.state !== "CHANGES_REQUESTED" && !r.body?.trim()) continue;
    consider(r.submittedAt);
  }
  for (const c of comments ?? []) {
    if (botLogin !== null && c.author?.login === botLogin) continue;
    if (!c.body?.trim()) continue;
    consider(c.createdAt);
  }
  return latest;
}

/** Probe the PR's merged state + concluded check failures + owner responses (one gh call). */
export async function runPrProbeLeg(prNumber: number, config: SubstrateConfig): Promise<PrProbe> {
  const view = (await $`gh pr view ${prNumber} --repo ${config.ghRepo} --json state,headRefOid,statusCheckRollup,reviews,comments`
    .quiet()
    .json()) as {
    state: string;
    headRefOid?: string;
    statusCheckRollup?: RollupItem[];
    reviews?: RawPrReview[];
    comments?: RawIssueComment[];
  };

  return {
    merged: view.state === "MERGED",
    headSha: view.headRefOid ?? null,
    failedChecks: failedChecksFrom(view.statusCheckRollup),
    ownerRespondedAt: latestOwnerResponseFrom(view.reviews, view.comments, await resolveBotLogin(config)),
  };
}
