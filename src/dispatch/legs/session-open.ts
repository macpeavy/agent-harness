// The session-open leg (service layer, ADR 0020) — stand up a session's build surface: a
// `session-main-<id>` branch off main and the one PR (session-main → main) the owner reviews.
// Chunks then build off this branch and squash-merge into it; the PR's diff accumulates.
//
// Opened once per session, at session start (the session loop calls it when a session has no
// branch yet). An empty marker commit gives the PR a commit so GitHub will open it before any
// chunk has landed; it's squashed away when the owner merges the session PR. The substrate
// owns git + GitHub; the loop links the returned branch/PR onto the session via the plan repo.
//
// Idempotent against the REMOTE, not just the local worktree (ADR 0020 robustness). A prior run
// can push the branch and/or open the PR, then crash before the loop records the linkage on the
// session — so `session.branch` stays null and the loop calls this again. Re-pushing over the
// now-diverged remote branch (non-fast-forward) or re-creating an existing PR both throw, which
// wedged the session on every retry. So: adopt an existing PR if there is one, reuse an existing
// remote branch rather than re-pushing, and only create+push when the branch is genuinely absent.

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

/** Create (or adopt) `session-main-<sessionId>` + its PR; returns the branch + PR linkage. */
export async function runSessionOpenLeg(
  sessionId: string,
  title: string,
  config: SubstrateConfig,
): Promise<SessionOpenResult> {
  const branch = `session-main-${sessionId}`;

  // 1. An open PR for this head already exists (a prior run got this far) → adopt it. This is
  //    the fully-recovered case: branch + PR are both already there, nothing to do but link.
  const existing = (await $`gh pr list --repo ${config.ghRepo} --head ${branch} --state open --json number,url`
    .quiet()
    .json()) as { number: number; url: string }[];
  if (existing.length > 0) {
    const pr = existing[0] as { number: number; url: string };
    return { branch, prNumber: pr.number, prUrl: pr.url };
  }

  // 2. The remote branch may already exist with no PR (a prior run crashed between the push and
  //    the PR create). Only create + push when it's genuinely absent; otherwise reuse it as-is —
  //    re-pushing a fresh commit would diverge and be rejected.
  const remoteBranch = (await $`git -C ${config.repoPath} ls-remote --heads origin ${branch}`.text()).trim();
  if (!remoteBranch) {
    mkdirSync(config.worktreeRoot, { recursive: true });
    const worktree = join(config.worktreeRoot, `open-${sessionId.replace(/[^a-zA-Z0-9]+/g, "-")}`);
    await removeWorktree(config.repoPath, worktree);
    await $`git -C ${config.repoPath} branch -D ${branch}`.nothrow().quiet();
    await $`git -C ${config.repoPath} fetch origin main`.quiet();
    await $`git -C ${config.repoPath} worktree add ${worktree} -b ${branch} origin/main`.quiet();
    try {
      // A marker commit so the PR has something to open against (session-main == main at start);
      // it's squashed away on the owner's final merge of the session PR.
      await $`git -C ${worktree} commit -q --allow-empty -m ${`chore: open session-main for ${sessionId}`}`;
      await $`git -C ${worktree} push -u origin ${branch}`.quiet();
    } finally {
      await removeWorktree(config.repoPath, worktree);
    }
  }

  // 3. The branch is on the remote now (freshly pushed or pre-existing) — open its PR.
  const body = `Session **${sessionId}** — chunks squash-merge here (ADR 0020). Review this one PR.\n\n${title}`;
  const prUrl = (
    await $`gh pr create --repo ${config.ghRepo} --head ${branch} --base main --title ${`Session ${sessionId}: ${title}`} --body ${body}`.text()
  ).trim();

  const prNumber = Number(prUrl.split("/").pop());
  if (!Number.isInteger(prNumber)) throw new Error(`session-open: could not parse PR number from '${prUrl}'`);
  return { branch, prNumber, prUrl };
}
