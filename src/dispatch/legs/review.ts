// The review leg (service layer) — review a chunk's branch with the strong reviewer over the
// token-free wake.
//
// Checks out the chunk branch in an isolated worktree, runs the reviewer agent in it (via the
// shared agent-runner, `wake` mode — fire prompt_async, wait for idle, no tokens burned while
// idle), and returns its verdict. The diff base is the chunk's session-main branch (ADR 0020),
// so the review sees exactly what the chunk adds to the session. No per-chunk PR comment — the
// one session PR is the review surface. Returns its result; the daemon persists the transitions.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../../opencode/agent-runner";
import { removeWorktree } from "./worktree";
import type { SubstrateConfig } from "../../config";

export interface ReviewTarget {
  /** The chunk branch to review. */
  branch: string;
  /** The base to diff against — the chunk's session-main branch (ADR 0020); `main` if unset. */
  sessionBranch?: string;
}

/** Whether the review found something worth an amend round (ADR 0008). */
export type ReviewVerdict = "blocking" | "clean";

export interface ReviewResult {
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

function slug(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9]+/g, "-");
}

export async function runReviewLeg(target: ReviewTarget, config: SubstrateConfig): Promise<ReviewResult> {
  const base = target.sessionBranch ?? "main";
  mkdirSync(config.worktreeRoot, { recursive: true });
  const worktree = join(config.worktreeRoot, `review-${slug(target.branch)}`);

  // Idempotent: clear any prior worktree, then check out the chunk head (detached).
  await removeWorktree(config.repoPath, worktree);
  await $`git -C ${config.repoPath} fetch origin ${target.branch} ${base}`.quiet();
  await $`git -C ${config.repoPath} worktree add --detach ${worktree} origin/${target.branch}`.quiet();

  try {
    // Run the reviewer over the token-free wake. The verdict line is reinforced HERE, in the
    // task prompt, not just the persona — the substrate parses it to gate the amend cycle, and
    // a model reliably follows an explicit task instruction where it drops a system-prompt
    // detail (AGENT-26: Sonnet was omitting it, so a clean review with no verdict amend-stormed).
    const prompt =
      `Review the changes on this branch against the session base. Run \`git diff origin/${base}...HEAD\` ` +
      `to see the diff, then return ranked findings per your role. You are read-only — do not edit or commit.\n\n` +
      `Your reply MUST end with a final line that is exactly one of:\n` +
      `  VERDICT: blocking   — there is at least one blocker or major finding that must change before merge\n` +
      `  VERDICT: clean      — no blocker/major findings (minor nits are fine and must not block)\n` +
      `This line is mandatory and parsed by the substrate to decide whether to amend; a missing verdict is treated as blocking.`;
    const run = await runAgent(worktree, {
      title: `review ${target.branch}`,
      agent: config.reviewerAgent,
      prompt,
      mode: "wake",
      idleMs: config.agentIdleMs,
      absoluteMs: config.agentTimeoutMs,
    });

    return {
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
