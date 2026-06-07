// The amend leg (service layer) — one amend round (ADR 0008).
//
// Given a PR branch with blocking review findings, check out that branch in a worktree,
// re-dispatch the builder (sync) with the findings as the amend prompt, and — if it
// changed anything — commit and push to the SAME branch, updating the PR. One round
// only: the daemon owns the cap loop, the re-review, and the escalation. Returns its
// result; the daemon persists the amend round + cost (the leg holds no registry/SQL).

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../../opencode/agent-runner";
import { removeWorktree } from "./worktree";
import type { SubstrateConfig } from "../../config";
import type { ReviewTarget } from "./review";

export interface AmendResult {
  changed: boolean;
  reply: string;
  route: string;
  tokens: { input: number; output: number };
}

export async function runAmendLeg(
  target: ReviewTarget,
  findings: string,
  config: SubstrateConfig,
): Promise<AmendResult> {
  mkdirSync(config.worktreeRoot, { recursive: true });
  const worktree = join(config.worktreeRoot, `amend-${target.pr}`);

  // Idempotent: clear any prior worktree, then check out the PR branch so we can commit
  // and push back to it. --force is defensive: the legs clean up their worktrees, but a
  // daemon killed between a build's push and its teardown could leave the build worktree
  // holding this branch, and --force overrides that already-checked-out guard.
  await removeWorktree(config.repoPath, worktree);
  await $`git -C ${config.repoPath} fetch origin ${target.branch}`.quiet();
  await $`git -C ${config.repoPath} worktree add --force ${worktree} -B ${target.branch} origin/${target.branch}`.quiet();
  // Install deps so the builder can typecheck/test its amend in-worktree.
  await $`bun install`.cwd(worktree).quiet();

  try {
    const prompt =
      `A reviewer raised blocking findings on your change. Address them by editing files in ` +
      `the current working directory, then typecheck/test. Do NOT run git or touch the PR — ` +
      `the substrate handles version control.\n\nReview findings:\n\n${findings}`;
    const run = await runAgent(worktree, {
      title: `amend PR #${target.pr}`,
      agent: config.builderAgent,
      prompt,
      mode: "sync",
    });

    // Did the amend change anything?
    const status = (await $`git -C ${worktree} status --porcelain`.text()).trim();
    if (!status) {
      return { changed: false, reply: run.reply, route: config.builderAgent, tokens: run.tokens };
    }

    // Push the fix onto the same branch — the PR updates in place.
    const commitMsg = `fix: address review findings (PR #${target.pr})`;
    await $`git -C ${worktree} add -A`.quiet();
    await $`git -C ${worktree} commit -q -m ${commitMsg}`;
    await $`git -C ${worktree} push origin ${target.branch}`.quiet();

    return { changed: true, reply: run.reply, route: config.builderAgent, tokens: run.tokens };
  } finally {
    await removeWorktree(config.repoPath, worktree);
  }
}
