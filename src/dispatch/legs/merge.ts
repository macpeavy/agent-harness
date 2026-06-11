// The merge leg (service layer, ADR 0020) — on a clean review, squash-merge a chunk's branch
// into its session-main branch and push, so the one session PR's diff updates. Replaces the
// per-chunk PR: chunks land into session-main locally; only session-main is the review surface.
//
// At land, the new-file droppings check (AGENT-53) classifies the chunk's ADDED files and
// annotates the session PR with anything that looks like a builder dropping (work-item-named
// files, unreferenced files) — non-blocking: the land proceeds either way, the annotation
// pre-highlights the owner's review.
//
// The substrate owns git. Returns whether anything merged; the daemon persists the transition.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { removeWorktree } from "./worktree";
import { fingerprintTokens, flagDroppings, type DroppingFlag } from "./droppings";
import type { SubstrateConfig } from "../../config";

export interface MergeTarget {
  /** The chunk's branch (pushed by the build leg). */
  branch: string;
  /** The session-main branch to squash-merge into. */
  sessionBranch: string;
  /** A human title for the squash commit. */
  title: string;
  /** Work-item ids (dispatch/issue) for the droppings fingerprint (AGENT-53). The branches
   *  are always included; these add the registry's ids when the daemon has them. */
  ids?: string[];
}

export interface MergeResult {
  merged: boolean;
  /** New files flagged by the droppings check (AGENT-53) — already annotated on the session
   *  PR (best-effort); returned so the daemon can log them. Empty when clean. */
  flagged: DroppingFlag[];
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
    if (!staged) return { merged: false, flagged: [] };

    // The droppings check (AGENT-53), on the staged ADDED files, before the commit so the
    // reference probe sees the final tree. Never blocks the land.
    const flagged = await checkDroppings(worktree, target);

    await $`git -C ${worktree} commit -q -m ${`feat: ${target.title}`}`;
    await $`git -C ${worktree} push origin ${target.sessionBranch}`.quiet();

    if (flagged.length > 0) await annotateSessionPr(target.sessionBranch, flagged, config);
    return { merged: true, flagged };
  } finally {
    await removeWorktree(config.repoPath, worktree);
  }
}

// Classify the staged ADDED files with the pure droppings rules; the reference probe is one
// fixed-string git grep per candidate (cheap at chunk scale). A probe error counts as
// referenced — over-trusting beats flagging on a git hiccup.
async function checkDroppings(worktree: string, target: MergeTarget): Promise<DroppingFlag[]> {
  const status = (await $`git -C ${worktree} diff --cached --name-status`.text()).trim();
  const added = status
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols[0] === "A" && cols[1])
    .map((cols) => cols[1] as string);
  if (added.length === 0) return [];

  const referenced = new Set<string>();
  for (const path of added) {
    const stem = basename(path).replace(/\.[^.]+$/, "");
    const hits = await $`git -C ${worktree} grep -l --fixed-strings ${stem} -- ${`:(exclude)${path}`}`
      .nothrow()
      .quiet()
      .text()
      .catch(() => "ref-probe-failed");
    if (hits.trim()) referenced.add(path);
  }

  const tokens = fingerprintTokens(target.branch, target.sessionBranch, ...(target.ids ?? []));
  return flagDroppings(added, tokens, (path) => referenced.has(path));
}

// Annotate the session PR with the flags — best-effort and non-blocking: a failed gh call
// logs and the land stands (the flags still ride back to the daemon's log line).
async function annotateSessionPr(sessionBranch: string, flagged: DroppingFlag[], config: SubstrateConfig): Promise<void> {
  const lines = flagged.map((f) => `- \`${f.path}\` — ${f.reason}`).join("\n");
  const body =
    `This chunk added file(s) that look like build droppings:\n\n${lines}\n\n` +
    `Acceptance checklists and self-verification notes belong in the chunk record, not the ` +
    `repo tree. Worth a look before merging.`;
  try {
    const prs = (await $`gh pr list --repo ${config.ghRepo} --head ${sessionBranch} --state open --json number`
      .quiet()
      .json()) as { number: number }[];
    const pr = prs[0]?.number;
    if (pr === undefined) return; // no open session PR — nothing to annotate
    await $`gh pr comment ${pr} --repo ${config.ghRepo} --body ${body}`.quiet();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`merge: droppings annotation failed for ${sessionBranch} (land unaffected): ${message}`);
  }
}
