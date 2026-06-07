// AGENT-8 — review + wake leg (gate G4).
//
// Given a PR (number + branch), check out the branch in an isolated worktree,
// dispatch the `reviewer` (strong route) over HTTP using the *token-free wake*:
// fire the prompt with prompt_async, then poll for the session to go idle
// (the substrate waits — not the agent — so no tokens burn while idle), collect
// the review, and post it on the PR. Builds on AGENT-7's serve + client.
//
// Run a one-off:  REVIEW_PR=23 bun run src/dispatch/review-leg.ts   (gateway up + env)

import { $ } from "bun";
import { OpencodeClient } from "../opencode/client";
import { startServe } from "../opencode/serve";

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

const REPO = process.env.AH_REPO ?? "/home/claude-dev/Developer/agent-harness";
const GH_REPO = process.env.AH_GH_REPO ?? "macpeavy/agent-harness";

export async function runReviewLeg(target: ReviewTarget): Promise<ReviewResult> {
  const worktree = `/tmp/ah-review-${target.pr}`;

  // Idempotent: clear any prior worktree, then check out the PR head (detached).
  await $`git -C ${REPO} worktree remove --force ${worktree}`.nothrow().quiet();
  await $`git -C ${REPO} fetch origin ${target.branch} main`.quiet();
  await $`git -C ${REPO} worktree add --detach ${worktree} origin/${target.branch}`.quiet();

  const serve = await startServe(worktree, 4098);
  let review = "";
  let waitedMs = 0;
  let tokens = { input: 0, output: 0 };
  try {
    const client = new OpencodeClient(serve.baseUrl);
    const sessionID = await client.createSession({ title: `review PR #${target.pr}`, agent: "reviewer" });
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
  const body = `**Automated review — reviewer route, dispatched via the token-free wake (AGENT-8):**\n\n${review}`;
  await $`gh pr comment ${target.pr} --repo ${GH_REPO} --body ${body}`.quiet();

  return { pr: target.pr, branch: target.branch, review, waitedMs, route: "reviewer", tokens };
}

if (import.meta.main) {
  const pr = Number(process.env.REVIEW_PR ?? "23");
  const branch = process.env.REVIEW_BRANCH ?? "agent/test-1-add-a-requireenv-helper";
  const res = await runReviewLeg({ pr, branch });
  console.log(`\n── review of PR #${res.pr} (idle detected after ${res.waitedMs}ms via wake) ──\n`);
  console.log(res.review);
  process.exit(res.review.length > 0 ? 0 : 1);
}
