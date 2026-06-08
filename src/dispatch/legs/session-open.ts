// The session-open leg (service layer, ADR 0020) — stand up a session's build surface: a
// `session-main-<id>` branch off main and the one PR (session-main → main) the owner reviews.
// Chunks then build off this branch and squash-merge into it; the PR's diff accumulates.
//
// Opened once per session, at session start (the session loop calls it when a session has no
// branch yet). An empty marker commit gives the PR a commit so GitHub will open it before any
// chunk has landed; it's squashed away when the owner merges the session PR. The substrate
// owns git + GitHub; the loop links the returned branch/PR onto the session via the plan repo.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { removeWorktree } from "./worktree";
import type { SubstrateConfig } from "../../config";

export interface SessionOpenResult {
  branch: string;
  prNumber: number;
  prUrl: string;
}

/** Create `session-main-<sessionId>` off main and open its PR; returns the branch + PR linkage. */
export async function runSessionOpenLeg(
  sessionId: string,
  title: string,
  config: SubstrateConfig,
): Promise<SessionOpenResult> {
  const branch = `session-main-${sessionId}`;
  mkdirSync(config.worktreeRoot, { recursive: true });
  const worktree = join(config.worktreeRoot, `open-${sessionId.replace(/[^a-zA-Z0-9]+/g, "-")}`);

  // Idempotent: clear any worktree/branch left by a prior run.
  await removeWorktree(config.repoPath, worktree);
  await $`git -C ${config.repoPath} branch -D ${branch}`.nothrow().quiet();

  await $`git -C ${config.repoPath} fetch origin main`.quiet();
  await $`git -C ${config.repoPath} worktree add ${worktree} -b ${branch} origin/main`.quiet();
  try {
    // A marker commit so the PR has something to open against (session-main == main at start);
    // it's squashed away on the owner's final merge of the session PR.
    await $`git -C ${worktree} commit -q --allow-empty -m ${`chore: open session-main for ${sessionId}`}`;
    await $`git -C ${worktree} push -u origin ${branch}`.quiet();

    const body = `Session **${sessionId}** — chunks squash-merge here (ADR 0020). Review this one PR.\n\n${title}`;
    const prUrl = (
      await $`gh pr create --repo ${config.ghRepo} --head ${branch} --base main --title ${`Session ${sessionId}: ${title}`} --body ${body}`.text()
    ).trim();

    const prNumber = Number(prUrl.split("/").pop());
    if (!Number.isInteger(prNumber)) throw new Error(`session-open: could not parse PR number from '${prUrl}'`);
    return { branch, prNumber, prUrl };
  } finally {
    await removeWorktree(config.repoPath, worktree);
  }
}
