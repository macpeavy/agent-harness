// Tests for the merge leg — exercises squash-merge into session-main using
// fixture repos (bare origin + local clone). No real GitHub or OpenCode server needed.
// The annotateSessionPr path calls `gh pr list` which fails silently on a local-path
// remote — that designed path is exercised in the droppings annotation case.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMergeLeg } from "./merge";
import type { MergeTarget } from "./merge";
import type { SubstrateConfig } from "../../config";

// Fixture: bare origin + local clone with session-main and a chunk branch.
interface Fixture {
  origin: string;
  local: string;
  sessionBranch: string;
  chunkBranch: string;
}

async function makeFixture(sessionBranch: string, chunkBranch: string): Promise<Fixture> {
  const origin = mkdtempSync(join(tmpdir(), "ah-merge-origin-"));
  const local = mkdtempSync(join(tmpdir(), "ah-merge-local-"));

  await $`git init --bare -q ${origin}`.quiet();
  await $`git clone -q ${origin} ${local}`.quiet();

  await $`git -C ${local} config user.email "test@test"`.quiet();
  await $`git -C ${local} config user.name "test"`.quiet();

  // Seed an initial commit on main so origin has a ref.
  writeFileSync(join(local, "README.md"), "init\n");
  await $`git -C ${local} add README.md`.quiet();
  await $`git -C ${local} commit -q -m "init"`.quiet();
  await $`git -C ${local} push -q origin HEAD:main`.quiet();

  // Create and push session-main from that same commit.
  await $`git -C ${local} push -q origin HEAD:refs/heads/${sessionBranch}`.quiet();

  // Create chunk branch off session-main with one additional commit.
  await $`git -C ${local} checkout -q -b ${chunkBranch}`.quiet();
  writeFileSync(join(local, "chunk-file.ts"), "export const x = 1;\n");
  await $`git -C ${local} add chunk-file.ts`.quiet();
  await $`git -C ${local} commit -q -m "feat: chunk work"`.quiet();
  await $`git -C ${local} push -q origin ${chunkBranch}`.quiet();

  // Return local HEAD to main so the working tree is clean.
  await $`git -C ${local} checkout -q main`.quiet();

  return { origin, local, sessionBranch, chunkBranch };
}

function makeConfig(fix: Fixture, worktreeRoot: string): SubstrateConfig {
  return {
    repoPath: fix.local,
    ghRepo: "local/test",
    worktreeRoot,
    builderAgent: "builder",
    builderStrongAgent: "builder-strong",
    reviewerAgent: "reviewer",
    amendCap: 3,
    agentIdleMs: 5_000,
    agentTimeoutMs: 30_000,
    prPollMs: 10_000,
    botLogin: null,
    ntfyTopic: null,
    ntfyServer: "https://ntfy.sh",
  };
}

function makeTarget(fix: Fixture): MergeTarget {
  return {
    branch: fix.chunkBranch,
    sessionBranch: fix.sessionBranch,
    title: "chunk work",
  };
}

let fix: Fixture;
let worktreeRoot: string;

beforeEach(async () => {
  fix = await makeFixture("session-main", "chunk/test-feat");
  worktreeRoot = mkdtempSync(join(tmpdir(), "ah-merge-wt-"));
});

afterEach(() => {
  rmSync(fix.origin, { recursive: true, force: true });
  rmSync(fix.local, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
});

describe("runMergeLeg", () => {
  it("happy path: chunk branch has a new commit → squash-merged, returns { merged: true }", async () => {
    const config = makeConfig(fix, worktreeRoot);
    const target = makeTarget(fix);

    const result = await runMergeLeg(target, config);

    expect(result.merged).toBe(true);
    // flagged is an array (may contain unreferenced-file entries; classification
    // is fully tested in droppings.test.ts — we just check the shape here).
    expect(Array.isArray(result.flagged)).toBe(true);

    // Verify the file from the chunk landed on origin/session-main.
    await $`git -C ${fix.local} fetch -q origin ${fix.sessionBranch}`.quiet();
    const files = await $`git -C ${fix.local} ls-tree --name-only origin/${fix.sessionBranch}`.text();
    expect(files).toContain("chunk-file.ts");
  });

  it("no-op: chunk branch already fully merged → returns { merged: false, flagged: [] }", async () => {
    const config = makeConfig(fix, worktreeRoot);
    const target = makeTarget(fix);

    // First call merges the chunk into session-main.
    await runMergeLeg(target, config);

    // Second call: the chunk's content is already on session-main; squash stages nothing.
    const result = await runMergeLeg(target, config);

    expect(result.merged).toBe(false);
    expect(result.flagged).toEqual([]);
  });

  it("idempotency: calling runMergeLeg twice does not throw or corrupt session-main", async () => {
    const config = makeConfig(fix, worktreeRoot);
    const target = makeTarget(fix);

    const first = await runMergeLeg(target, config);
    expect(first.merged).toBe(true);

    // Second call is the no-op path — must not throw.
    const second = await runMergeLeg(target, config);
    expect(second.merged).toBe(false);

    // session-main on origin still contains exactly one squash commit of the chunk file.
    await $`git -C ${fix.local} fetch -q origin ${fix.sessionBranch}`.quiet();
    const log = await $`git -C ${fix.local} log --oneline origin/${fix.sessionBranch}`.text();
    const lines = log.trim().split("\n").filter(Boolean);
    // The initial "init" commit + one squash commit = 2.
    expect(lines.length).toBe(2);
  });

  it("worktree teardown: worktree directory is gone after a successful merge", async () => {
    const config = makeConfig(fix, worktreeRoot);
    const target = makeTarget(fix);

    await runMergeLeg(target, config);

    const slug = fix.chunkBranch.replace(/[^a-zA-Z0-9]+/g, "-");
    const worktreePath = join(worktreeRoot, `merge-${slug}`);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("worktree teardown on conflict: a merge conflict causes a throw; worktree is cleaned up", async () => {
    // Create a conflicting commit on session-main after the chunk branch diverged.
    // Both session-main and the chunk branch modify the same file with different content.
    await $`git -C ${fix.local} fetch -q origin ${fix.sessionBranch}`.quiet();
    await $`git -C ${fix.local} checkout -q -B ${fix.sessionBranch} origin/${fix.sessionBranch}`.quiet();
    writeFileSync(join(fix.local, "conflict.ts"), "export const v = 'session';\n");
    await $`git -C ${fix.local} add conflict.ts`.quiet();
    await $`git -C ${fix.local} commit -q -m "session-main change"`.quiet();
    await $`git -C ${fix.local} push -q origin ${fix.sessionBranch}`.quiet();

    // Add the same file on the chunk branch with different content.
    await $`git -C ${fix.local} checkout -q ${fix.chunkBranch}`.quiet();
    // Reset chunk branch to the original base (before the session-main diverged) so there's a real conflict.
    // Re-create the conflict file on the chunk branch.
    writeFileSync(join(fix.local, "conflict.ts"), "export const v = 'chunk';\n");
    await $`git -C ${fix.local} add conflict.ts`.quiet();
    await $`git -C ${fix.local} commit -q -m "chunk conflict"`.quiet();
    await $`git -C ${fix.local} push -q -f origin ${fix.chunkBranch}`.quiet();

    await $`git -C ${fix.local} checkout -q main`.quiet();

    const config = makeConfig(fix, worktreeRoot);
    const target = makeTarget(fix);

    await expect(runMergeLeg(target, config)).rejects.toThrow();

    const slug = fix.chunkBranch.replace(/[^a-zA-Z0-9]+/g, "-");
    const worktreePath = join(worktreeRoot, `merge-${slug}`);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("droppings annotation: gh pr list fails silently on local remote; merge result is still { merged: true }", async () => {
    // Add a file whose name echoes the chunk's branch tokens with a number so it gets flagged.
    // chunk branch is "chunk/test-feat"; we need something like "chunk-test-123.md" that
    // has no inbound reference, to trigger the droppings annotation path.
    // Simplest: add a file named after a fake issue number that will be unreferenced.
    await $`git -C ${fix.local} fetch -q origin ${fix.chunkBranch}`.quiet();
    await $`git -C ${fix.local} checkout -q ${fix.chunkBranch}`.quiet();
    writeFileSync(join(fix.local, "dropping-123.md"), "checklist\n");
    await $`git -C ${fix.local} add dropping-123.md`.quiet();
    await $`git -C ${fix.local} commit -q -m "add dropping"`.quiet();
    await $`git -C ${fix.local} push -q origin ${fix.chunkBranch}`.quiet();
    await $`git -C ${fix.local} checkout -q main`.quiet();

    const config = makeConfig(fix, worktreeRoot);
    // Use an id that causes the dropping filename to be fingerprinted.
    const target: MergeTarget = {
      branch: fix.chunkBranch,
      sessionBranch: fix.sessionBranch,
      title: "chunk work",
      ids: ["dropping-123"],
    };

    // The gh call inside annotateSessionPr will fail (local path, not a real repo).
    // The function must catch and return merged: true without throwing.
    const result = await runMergeLeg(target, config);

    expect(result.merged).toBe(true);
    // The dropping file is flagged (unreferenced or named-after-id).
    // We just check the merge succeeded; we don't assert the exact flagged entries
    // because the droppings classification is covered in droppings.test.ts.
  });
});
