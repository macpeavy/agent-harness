// The merge leg (service layer, ADR 0020) — on a clean review, squash-merge a chunk's branch
// into its session-main branch and push, so the one session PR's diff updates. Replaces the
// per-chunk PR: chunks land into session-main locally; only session-main is the review surface.
//
// The substrate owns git. Returns whether anything merged; the daemon persists the transition.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { removeWorktree } from "./worktree";
import type { SubstrateConfig } from "../../config";

export interface MergeTarget {
  /** The chunk's branch (pushed by the build leg). */
  branch: string;
  /** The session-main branch to squash-merge into. */
  sessionBranch: string;
  /** A human title for the squash commit. */
  title: string;
}

export interface MergeResult {
  merged: boolean;
}

/** Squash-merge `target.branch` into `target.sessionBranch` and push session-main. */
export async function runMergeLeg(target: MergeTarget, config: SubstrateConfig): Promise<MergeResult> {
  mkdirSync(config.worktreeRoot, { recursive: true });
  const worktree = join(config.worktreeRoot, `merge-${target.branch.replace(/[^a-zA-Z0-9]+/g, "-")}`);

  await removeWorktree(config.repoPath, worktree);
  await $`git -C ${config.repoPath} fetch origin ${target.sessionBranch} ${target.branch}`.quiet();
  // A worktree on session-main (reset to origin's tip), then squash the chunk in.
  await $`git -C ${config.repoPath} worktree add --force ${worktree} -B ${target.sessionBranch} origin/${target.sessionBranch}`.quiet();

  try {
    await $`git -C ${worktree} merge --squash origin/${target.branch}`.quiet();
    // Nothing staged → the chunk added nothing new to session-main; not an error, just no-op.
    const staged = (await $`git -C ${worktree} diff --cached --name-only`.text()).trim();
    if (!staged) return { merged: false };

    await $`git -C ${worktree} commit -q -m ${`feat: ${target.title}`}`;
    await $`git -C ${worktree} push origin ${target.sessionBranch}`.quiet();
    return { merged: true };
  } finally {
    await removeWorktree(config.repoPath, worktree);
  }
}
