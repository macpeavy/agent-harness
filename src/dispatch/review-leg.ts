// The review leg (service layer) — review a PR with the strong reviewer over the
// token-free wake.
//
// Given a PR (number + branch) and the substrate config, it checks out the branch in
// an isolated worktree, dispatches the reviewer agent (strong route) over HTTP using
// the *token-free wake* (fire the prompt with prompt_async, then poll for the session
// to go idle — the substrate waits, not the agent, so no tokens burn while idle),
// collects the review, and posts it on the PR. Returns its result; the daemon
// (AGENT-19) persists the transitions — the leg holds no registry/SQL.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OpencodeClient } from "../opencode/client";
import { startServe } from "../opencode/serve";
import type { SubstrateConfig } from "../config";

export interface ReviewTarget {
  pr: number;
  branch: string;
}

export interface ReviewResult {
  pr: number;
  branch: string;
  review: string;
  waitedMs: number;
  route: string;
  tokens: { input: number; output: number };
}

export async function runReviewLeg(
  target: ReviewTarget,
  config: SubstrateConfig,
): Promise<ReviewResult> {
  mkdirSync(config.worktreeRoot, { recursive: true });
  const worktree = join(config.worktreeRoot, `review-${target.pr}`);

  // Idempotent: clear any prior worktree, then check out the PR head (detached).
  await $`git -C ${config.repoPath} worktree remove --force ${worktree}`.nothrow().quiet();
  await $`git -C ${config.repoPath} fetch origin ${target.branch} main`.quiet();
  await $`git -C ${config.repoPath} worktree add --detach ${worktree} origin/${target.branch}`.quiet();

  const serve = await startServe(worktree);
  let review = "";
  let waitedMs = 0;
  let tokens = { input: 0, output: 0 };
  try {
    const client = new OpencodeClient(serve.baseUrl);
    const sessionID = await client.createSession({
      title: `review PR #${target.pr}`,
      agent: config.reviewerAgent,
    });
    const prompt =
      `Review the changes on this branch against main. Run \`git diff origin/main...HEAD\` ` +
      `to see the diff, then return ranked findings per your role. You are read-only — do not edit or commit.`;

    // Token-free wake: fire async, then the substrate waits for idle.
    const start = Date.now();
    await client.promptAsync(sessionID, prompt);
    review = (await client.waitForReply(sessionID)).text;
    waitedMs = Date.now() - start;
    tokens = await client.sessionTokens(sessionID);
  } finally {
    serve.stop();
  }

  // Substrate posts the reviewer's findings (comment only).
  const body = `**Automated review — ${config.reviewerAgent} route, dispatched via the token-free wake:**\n\n${review}`;
  await $`gh pr comment ${target.pr} --repo ${config.ghRepo} --body ${body}`.quiet();

  return { pr: target.pr, branch: target.branch, review, waitedMs, route: config.reviewerAgent, tokens };
}
