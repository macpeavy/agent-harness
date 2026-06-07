// Worktree teardown shared by the legs.
//
// Every leg runs its agent in an isolated git worktree under the config's worktreeRoot.
// Each leg owns that worktree's whole lifecycle: it removes any stale one before
// creating (idempotent reset), and removes its own in a `finally` when done — so a
// long-running daemon doesn't accumulate worktrees, and the branch a build leg checked
// out is freed for the amend leg. The branch itself lives in origin (pushed), so
// dropping the local worktree loses nothing.

import { $ } from "bun";

/**
 * Remove a git worktree if it exists. Idempotent — `.nothrow()` so a missing worktree
 * (no prior run, or already cleaned) is a no-op, not an error.
 */
export async function removeWorktree(repoPath: string, worktree: string): Promise<void> {
  await $`git -C ${repoPath} worktree remove --force ${worktree}`.nothrow().quiet();
}
