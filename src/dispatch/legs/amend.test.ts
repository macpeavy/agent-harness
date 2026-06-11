// Tests for the amend leg — exercises the git workflow (fetch, worktree-add,
// commit, push, teardown) using fixture repos and injected stubs for runAgent
// and bun install.  No real OpenCode server is needed.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAmendLeg } from "./amend";
import type { SubstrateConfig } from "../../config";
import type { RunAgentOpts, AgentRun } from "../../opencode/agent-runner";

// A stub AgentRun returned by every agent stub below.
const STUB_RUN: AgentRun = {
  sessionId: "stub-session",
  reply: "ok",
  waitedMs: 0,
  tokens: { input: 10, output: 5 },
};

// no-op install stub — avoids running real `bun install` in a fixture repo that
// has no package.json/bun.lock.
const noInstall = async (_wt: string): Promise<void> => {};

// Fixture: bare origin + local clone with one commit + the branch pushed to origin.
interface Fixture {
  origin: string;
  local: string;
  branch: string;
}

async function makeFixture(branch: string): Promise<Fixture> {
  const origin = mkdtempSync(join(tmpdir(), "ah-amend-origin-"));
  const local = mkdtempSync(join(tmpdir(), "ah-amend-local-"));

  await $`git init --bare -q ${origin}`.quiet();
  await $`git clone -q ${origin} ${local}`.quiet();

  // Configure identity so commits don't fail on a headless CI box.
  await $`git -C ${local} config user.email "test@test"`.quiet();
  await $`git -C ${local} config user.name "Test"`.quiet();

  // Seed an initial commit so origin/main exists.
  await $`git -C ${local} commit -q --allow-empty -m init`.quiet();
  await $`git -C ${local} push -q origin HEAD:main`.quiet();

  // Push the branch the leg will fetch and check out.
  await $`git -C ${local} push -q origin HEAD:refs/heads/${branch}`.quiet();

  return { origin, local, branch };
}

function makeConfig(fix: Fixture, worktreeRoot: string): SubstrateConfig {
  return {
    repoPath: fix.local,
    ghRepo: "owner/repo",
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

let fix: Fixture;
let worktreeRoot: string;

beforeEach(async () => {
  fix = await makeFixture("chunk/test-branch");
  worktreeRoot = mkdtempSync(join(tmpdir(), "ah-amend-wt-"));
});

afterEach(() => {
  rmSync(fix.origin, { recursive: true, force: true });
  rmSync(fix.local, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
});

describe("runAmendLeg", () => {
  it("happy path: agent writes a file → changed=true, commit pushed to branch", async () => {
    // Agent stub writes a file to the worktree to simulate an edit.
    const agentStub = async (worktree: string, _opts: RunAgentOpts): Promise<AgentRun> => {
      writeFileSync(join(worktree, "amended.txt"), "fixed\n");
      return STUB_RUN;
    };

    const config = makeConfig(fix, worktreeRoot);
    const result = await runAmendLeg(
      { branch: fix.branch },
      "fix the thing",
      config,
      undefined,
      agentStub,
      noInstall,
    );

    expect(result.changed).toBe(true);
    expect(result.reply).toBe("ok");
    expect(result.tokens).toEqual({ input: 10, output: 5 });

    // Verify the commit landed on origin — fetch origin and check the file is there.
    await $`git -C ${fix.local} fetch -q origin ${fix.branch}`.quiet();
    const files = await $`git -C ${fix.local} ls-tree --name-only origin/${fix.branch}`.text();
    expect(files).toContain("amended.txt");
  });

  it("no change: agent returns without editing files → changed=false, no new commit", async () => {
    // Capture the tip SHA before the leg runs.
    await $`git -C ${fix.local} fetch -q origin ${fix.branch}`.quiet();
    const before = (await $`git -C ${fix.local} rev-parse origin/${fix.branch}`.text()).trim();

    const agentStub = async (_worktree: string, _opts: RunAgentOpts): Promise<AgentRun> => STUB_RUN;

    const config = makeConfig(fix, worktreeRoot);
    const result = await runAmendLeg(
      { branch: fix.branch },
      "nothing to fix",
      config,
      undefined,
      agentStub,
      noInstall,
    );

    expect(result.changed).toBe(false);

    // Branch tip on origin must not have advanced.
    await $`git -C ${fix.local} fetch -q origin ${fix.branch}`.quiet();
    const after = (await $`git -C ${fix.local} rev-parse origin/${fix.branch}`.text()).trim();
    expect(after).toBe(before);
  });

  it("worktree teardown on success: worktree directory is gone after the call", async () => {
    const agentStub = async (_worktree: string, _opts: RunAgentOpts): Promise<AgentRun> => STUB_RUN;
    const config = makeConfig(fix, worktreeRoot);

    await runAmendLeg({ branch: fix.branch }, "findings", config, undefined, agentStub, noInstall);

    // The worktree path the leg derives is deterministic — match the slug logic.
    const slug = fix.branch.replace(/[^a-zA-Z0-9]+/g, "-");
    const worktreePath = join(worktreeRoot, `amend-${slug}`);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("worktree teardown on failure: worktree is gone even when the agent stub throws", async () => {
    const agentStub = async (_worktree: string, _opts: RunAgentOpts): Promise<AgentRun> => {
      throw new Error("agent blew up");
    };
    const config = makeConfig(fix, worktreeRoot);

    await expect(
      runAmendLeg({ branch: fix.branch }, "findings", config, undefined, agentStub, noInstall),
    ).rejects.toThrow("agent blew up");

    const slug = fix.branch.replace(/[^a-zA-Z0-9]+/g, "-");
    const worktreePath = join(worktreeRoot, `amend-${slug}`);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("idempotency: calling runAmendLeg twice on the same branch does not leave two worktrees or throw", async () => {
    const agentStub = async (_worktree: string, _opts: RunAgentOpts): Promise<AgentRun> => STUB_RUN;
    const config = makeConfig(fix, worktreeRoot);

    // First call — completes cleanly.
    await runAmendLeg({ branch: fix.branch }, "findings", config, undefined, agentStub, noInstall);

    // Second call — should not throw (stale worktree removed idempotently before re-adding).
    await expect(
      runAmendLeg({ branch: fix.branch }, "findings again", config, undefined, agentStub, noInstall),
    ).resolves.toBeDefined();

    // And the worktree is cleaned up after the second call too.
    const slug = fix.branch.replace(/[^a-zA-Z0-9]+/g, "-");
    const worktreePath = join(worktreeRoot, `amend-${slug}`);
    expect(existsSync(worktreePath)).toBe(false);
  });
});
