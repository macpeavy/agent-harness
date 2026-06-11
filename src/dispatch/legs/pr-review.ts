// The PR-review-read leg (service layer, ADR 0020 slice 4b) — read a session PR's review
// feedback off GitHub so the substrate can route it into the amend cycle. Read-only: it does
// no git and writes nothing; it shells out to `gh api` and returns structured comments. The
// chief's `address_review` tool calls it, then hands the comments to the service for routing.
//
// Three sources make up "the owner reviewed the PR" (AGENT-54 widened the read): inline
// review comments (anchored to a file `path` — the routable ones, mapped to a chunk by its
// surface), review summaries (a top-level body with no path — general feedback that surfaces
// to the chief), and Conversation-tab issue comments (also general feedback — owner notes
// left there were previously invisible). Approvals and empty-body reviews carry no actionable
// note and are dropped; anything authored by the harness's own login is filtered out, so the
// bot's words never route back as owner findings.

import { $ } from "bun";
import type { SubstrateConfig } from "../../config";
import { resolveBotLogin } from "./gh-identity";

/** One piece of owner feedback on a session PR. `path` set = inline (routable to a chunk by
 *  surface); `path` null = a general note (a review summary or an issue comment). */
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
interface RawIssueComment {
  body: string;
  user: { login: string } | null;
}

/** Read a session PR's review feedback (inline comments + review summaries + Conversation-tab
 *  issue comments) via `gh api`, excluding the harness's own identity. */
export async function runReadPrReviewLeg(prNumber: number, config: SubstrateConfig): Promise<PrComment[]> {
  const repo = config.ghRepo;
  const inline = (await $`gh api --paginate repos/${repo}/pulls/${prNumber}/comments`.json()) as RawInlineComment[];
  const reviews = (await $`gh api --paginate repos/${repo}/pulls/${prNumber}/reviews`.json()) as RawReview[];
  // A PR is an issue for Conversation-tab comments — the issues endpoint reads them.
  const conversation = (await $`gh api --paginate repos/${repo}/issues/${prNumber}/comments`.json()) as RawIssueComment[];
  const botLogin = await resolveBotLogin(config);
  const isBot = (user: { login: string } | null): boolean => botLogin !== null && user?.login === botLogin;

  const comments: PrComment[] = [];
  for (const c of inline) {
    const body = c.body?.trim();
    if (!body || isBot(c.user)) continue;
    comments.push({ path: c.path, body, author: c.user?.login ?? "unknown" });
  }
  for (const r of reviews) {
    const body = r.body?.trim();
    if (!body || isBot(r.user)) continue; // an APPROVED / empty-body review carries no note to action
    comments.push({ path: null, body, author: r.user?.login ?? "unknown" });
  }
  for (const c of conversation) {
    const body = c.body?.trim();
    if (!body || isBot(c.user)) continue;
    comments.push({ path: null, body, author: c.user?.login ?? "unknown" });
  }
  return comments;
}
