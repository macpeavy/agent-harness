import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorktree } from "./worktree";

let repo: string;
let worktree: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ah-wt-repo-"));
  worktree = `${repo}-tree`; // a path that doesn't exist yet — git worktree add creates it
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} commit -q --allow-empty -m init`.quiet();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe("removeWorktree", () => {
  it("removes an existing worktree", async () => {
    await $`git -C ${repo} worktree add --detach -q ${worktree} HEAD`.quiet();
    expect(existsSync(worktree)).toBe(true);

    await removeWorktree(repo, worktree);

    expect(existsSync(worktree)).toBe(false);
  });

  it("is a no-op (does not throw) when the worktree was never created", async () => {
    await expect(removeWorktree(repo, worktree)).resolves.toBeUndefined();
  });

  it("is idempotent — removing twice does not throw", async () => {
    await $`git -C ${repo} worktree add --detach -q ${worktree} HEAD`.quiet();
    await removeWorktree(repo, worktree);
    await expect(removeWorktree(repo, worktree)).resolves.toBeUndefined();
  });
});
