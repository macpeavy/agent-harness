// Tests for the session-open leg — exercises branch creation, PR adoption, and idempotency
// using fixture repos (bare origin + local clone). The ghFn injection means no real GitHub
// is needed; git operations run against a local bare remote.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionOpenLeg, type GhFn } from "./session-open";
import type { SubstrateConfig } from "../../config";

interface Fixture {
  origin: string;
  local: string;
}

async function makeFixture(): Promise<Fixture> {
  const origin = mkdtempSync(join(tmpdir(), "ah-so-origin-"));
  const local = mkdtempSync(join(tmpdir(), "ah-so-local-"));

  await $`git init --bare -q ${origin}`.quiet();
  await $`git clone -q ${origin} ${local}`.quiet();

  await $`git -C ${local} config user.email "test@test"`.quiet();
  await $`git -C ${local} config user.name "test"`.quiet();

  writeFileSync(join(local, "README.md"), "init\n");
  await $`git -C ${local} add README.md`.quiet();
  await $`git -C ${local} commit -q -m "init"`.quiet();
  await $`git -C ${local} push -q origin HEAD:main`.quiet();

  return { origin, local };
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

/** Build a ghFn stub that consumes canned responses in order. */
function makeGhStub(responses: string[]): GhFn {
  let i = 0;
  return async (_args: string[], _input?: string): Promise<string> => {
    if (i >= responses.length) throw new Error(`ghFn stub: no response left for call ${i}`);
    return responses[i++] ?? "";
  };
}

let fix: Fixture;
let worktreeRoot: string;

beforeEach(async () => {
  fix = await makeFixture();
  worktreeRoot = mkdtempSync(join(tmpdir(), "ah-so-wt-"));
});

afterEach(() => {
  rmSync(fix.origin, { recursive: true, force: true });
  rmSync(fix.local, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
});

describe("runSessionOpenLeg", () => {
  it("fresh open: branch absent on remote, no existing PR → creates branch+marker commit, returns { branch, prNumber, prUrl }", async () => {
    const ghFn = makeGhStub([
      "[]",                                        // pr list → no existing PR
      "https://github.com/x/y/pull/7",             // pr create → new PR url
    ]);
    const config = makeConfig(fix, worktreeRoot);

    const result = await runSessionOpenLeg("s1", "My session title", config, ghFn);

    expect(result.branch).toBe("session-main-s1");
    expect(result.prNumber).toBe(7);
    expect(result.prUrl).toBe("https://github.com/x/y/pull/7");

    // Branch was pushed to origin.
    const refs = (await $`git -C ${fix.local} ls-remote --heads origin session-main-s1`.text()).trim();
    expect(refs).toContain("session-main-s1");
  });

  it("adopt existing PR: ghFn returns a PR on the first list call → skips git work, returns existing linkage", async () => {
    const ghFn = makeGhStub([
      '[{"number":42,"url":"https://github.com/x/y/pull/42"}]', // pr list → existing PR
      // pr create must NOT be called
    ]);
    const config = makeConfig(fix, worktreeRoot);

    const result = await runSessionOpenLeg("s-adopt", "title", config, ghFn);

    expect(result.branch).toBe("session-main-s-adopt");
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe("https://github.com/x/y/pull/42");

    // No branch was pushed (git work was skipped).
    const refs = (await $`git -C ${fix.local} ls-remote --heads origin session-main-s-adopt`.text()).trim();
    expect(refs).toBe("");
  });

  it("adopt branch, create PR: branch exists on remote but no open PR → skips branch creation, calls ghFn to create PR", async () => {
    // Pre-push the branch to origin without a PR.
    await $`git -C ${fix.local} push -q origin HEAD:refs/heads/session-main-s-branch`.quiet();

    const ghFn = makeGhStub([
      "[]",                                        // pr list → no existing PR
      "https://github.com/x/y/pull/99",            // pr create
    ]);
    const config = makeConfig(fix, worktreeRoot);

    const result = await runSessionOpenLeg("s-branch", "title", config, ghFn);

    expect(result.branch).toBe("session-main-s-branch");
    expect(result.prNumber).toBe(99);
    expect(result.prUrl).toBe("https://github.com/x/y/pull/99");
  });

  it("worktree teardown on success: worktree directory is gone after the call", async () => {
    const ghFn = makeGhStub([
      "[]",
      "https://github.com/x/y/pull/7",
    ]);
    const config = makeConfig(fix, worktreeRoot);

    await runSessionOpenLeg("s-wt", "title", config, ghFn);

    const worktreePath = join(worktreeRoot, "open-s-wt");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("worktree teardown on failure: git push stub throws; worktree is still cleaned up", async () => {
    // Make push fail by making origin's main branch diverge so the push is rejected.
    // We do it by making the remote non-bare and then pushing to it in a way that breaks.
    // Simpler: replace origin with a path that doesn't exist so push fails outright.
    const badConfig: SubstrateConfig = {
      ...makeConfig(fix, worktreeRoot),
      repoPath: fix.local,
    };

    // Point local's origin to a non-existent path to force push failure.
    await $`git -C ${fix.local} remote set-url origin /does/not/exist`.quiet();

    const ghFn = makeGhStub(["[]"]);

    await expect(runSessionOpenLeg("s-fail", "title", badConfig, ghFn)).rejects.toThrow();

    const worktreePath = join(worktreeRoot, "open-s-fail");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("re-open idempotency: second call with ghFn returning existing PR → returns same linkage without creating a new branch", async () => {
    // First call: fresh open.
    const ghFnFirst = makeGhStub([
      "[]",
      "https://github.com/x/y/pull/7",
    ]);
    const config = makeConfig(fix, worktreeRoot);
    const first = await runSessionOpenLeg("s-idem", "title", config, ghFnFirst);
    expect(first.prNumber).toBe(7);

    // Second call: ghFn returns the existing PR.
    const ghFnSecond = makeGhStub([
      '[{"number":7,"url":"https://github.com/x/y/pull/7"}]',
    ]);
    const second = await runSessionOpenLeg("s-idem", "title", config, ghFnSecond);

    expect(second.branch).toBe(first.branch);
    expect(second.prNumber).toBe(first.prNumber);
    expect(second.prUrl).toBe(first.prUrl);
  });
});
