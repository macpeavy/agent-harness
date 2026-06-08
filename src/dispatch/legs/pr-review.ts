// The PR-review-read leg (service layer, ADR 0020 slice 4b) — read a session PR's review
// feedback off GitHub so the substrate can route it into the amend cycle. Read-only: it does
// no git and writes nothing; it shells out to `gh api` and returns structured comments. The
// chief's `address_review` tool calls it, then hands the comments to the service for routing.
//
// Two sources make up "the owner reviewed the PR": inline review comments (anchored to a file
// `path` — the routable ones, mapped to a chunk by its surface) and review summaries (a
// top-level body with no path — general feedback that surfaces to the chief). Approvals and
// empty-body reviews carry no actionable note and are dropped.

import { $ } from "bun";
import type { SubstrateConfig } from "../../config";

/** One piece of owner feedback on a session PR. `path` set = inline (routable to a chunk by
 *  surface); `path` null = a general review summary (surfaces to the chief). */
export interface PrComment {
  path: string | null;
  body: string;
  author: string;
}

// The slices of the GitHub REST shapes we read (gh api returns the full objects).
interface RawInlineComment {
  path: string;
  body: string;
  user: { login: string } | null;
}
interface RawReview {
  body: string;
  user: { login: string } | null;
}

/** Read a session PR's review feedback (inline comments + review summaries) via `gh api`. */
export async function runReadPrReviewLeg(prNumber: number, config: SubstrateConfig): Promise<PrComment[]> {
  const repo = config.ghRepo;
  const inline = (await $`gh api --paginate repos/${repo}/pulls/${prNumber}/comments`.json()) as RawInlineComment[];
  const reviews = (await $`gh api --paginate repos/${repo}/pulls/${prNumber}/reviews`.json()) as RawReview[];

  const comments: PrComment[] = [];
  for (const c of inline) {
    const body = c.body?.trim();
    if (!body) continue;
    comments.push({ path: c.path, body, author: c.user?.login ?? "unknown" });
  }
  for (const r of reviews) {
    const body = r.body?.trim();
    if (!body) continue; // an APPROVED / empty-body review carries no note to action
    comments.push({ path: null, body, author: r.user?.login ?? "unknown" });
  }
  return comments;
}
