// The review leg (service layer) — review a PR with the strong reviewer over the
// token-free wake.
//
// Checks out the PR branch in an isolated worktree, runs the reviewer agent in it (via
// the shared agent-runner, `wake` mode — fire prompt_async, wait for idle, no tokens
// burned while idle), and posts the review on the PR. Returns its result; the daemon
// (AGENT-19) persists the transitions — the leg holds no registry/SQL.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../../opencode/agent-runner";
import { removeWorktree } from "./worktree";
import type { SubstrateConfig } from "../../config";

export interface ReviewTarget {
  pr: number;
  branch: string;
}

/** Whether the review found something worth an amend round (ADR 0008). */
export type ReviewVerdict = "blocking" | "clean";

export interface ReviewResult {
  pr: number;
  branch: string;
  review: string;
  /** Parsed from the reviewer's mandatory final `VERDICT:` line — drives the amend cycle. */
  verdict: ReviewVerdict;
  waitedMs: number;
  route: string;
  reviewSessionId: string;
  tokens: { input: number; output: number };
}

/**
 * Read the reviewer's verdict from its output. The reviewer ends with a `VERDICT:
 * blocking|clean` line (agents/reviewer.md); we take the last such line. Absent or
 * unparseable → `blocking`, the safe default: never auto-ship a review we couldn't
 * classify — a stuck dispatch escalates to a human rather than merging unread.
 */
export function parseVerdict(reviewText: string): ReviewVerdict {
  const matches = reviewText.matchAll(/^\s*VERDICT:\s*(blocking|clean)\b/gim);
  let last: ReviewVerdict | null = null;
  for (const m of matches) last = m[1]?.toLowerCase() === "clean" ? "clean" : "blocking";
  return last ?? "blocking";
}

export async function runReviewLeg(
  target: ReviewTarget,
  config: SubstrateConfig,
): Promise<ReviewResult> {
  mkdirSync(config.worktreeRoot, { recursive: true });
  const worktree = join(config.worktreeRoot, `review-${target.pr}`);

  // Idempotent: clear any prior worktree, then check out the PR head (detached).
  await removeWorktree(config.repoPath, worktree);
  await $`git -C ${config.repoPath} fetch origin ${target.branch} main`.quiet();
  await $`git -C ${config.repoPath} worktree add --detach ${worktree} origin/${target.branch}`.quiet();

  try {
    // Run the reviewer over the token-free wake.
    const prompt =
      `Review the changes on this branch against main. Run \`git diff origin/main...HEAD\` ` +
      `to see the diff, then return ranked findings per your role. You are read-only — do not edit or commit.`;
    const run = await runAgent(worktree, {
      title: `review PR #${target.pr}`,
      agent: config.reviewerAgent,
      prompt,
      mode: "wake",
    });

    // Substrate posts the reviewer's findings (comment only).
    const body = `**Automated review — ${config.reviewerAgent} route, dispatched via the token-free wake:**\n\n${run.reply}`;
    await $`gh pr comment ${target.pr} --repo ${config.ghRepo} --body ${body}`.quiet();

    return {
      pr: target.pr,
      branch: target.branch,
      review: run.reply,
      verdict: parseVerdict(run.reply),
      waitedMs: run.waitedMs,
      route: config.reviewerAgent,
      reviewSessionId: run.sessionId,
      tokens: run.tokens,
    };
  } finally {
    await removeWorktree(config.repoPath, worktree);
  }
}
