// The build leg (service layer) — dispatch one issue to the cheap builder.
//
// Creates an isolated git worktree on a fresh branch off origin/main, runs the builder
// agent in it (via the shared agent-runner), then — if the builder changed anything —
// commits the diff, pushes, and opens a PR. The substrate owns git + GitHub; the agent
// owns the code. It returns its result; the daemon (AGENT-19) persists the transitions
// via the repository — the leg holds no registry/SQL.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../../opencode/agent-runner";
import type { SubstrateConfig } from "../../config";

export interface Issue {
  id: string;
  title: string;
  body: string;
}

export interface BuildResult {
  branch: string;
  worktree: string;
  changed: boolean;
  reply: string;
  prUrl?: string;
  route: string;
  buildSessionId: string;
  tokens: { input: number; output: number };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** The branch a dispatch builds on — deterministic from the issue, so the enqueuer and
 *  the build leg agree (the review leg reviews the branch the registry recorded). */
export function dispatchBranch(issue: Issue): string {
  return `agent/${issue.id.toLowerCase()}-${slugify(issue.title)}`;
}

export async function runBuildLeg(issue: Issue, config: SubstrateConfig): Promise<BuildResult> {
  const id = issue.id.toLowerCase();
  const branch = dispatchBranch(issue);
  mkdirSync(config.worktreeRoot, { recursive: true });
  const worktree = join(config.worktreeRoot, `build-${id}`);

  // Idempotent: clear any worktree/branch left by a prior run.
  await $`git -C ${config.repoPath} worktree remove --force ${worktree}`.nothrow().quiet();
  await $`git -C ${config.repoPath} branch -D ${branch}`.nothrow().quiet();

  // 1. Isolated worktree on a fresh branch off the latest origin/main.
  await $`git -C ${config.repoPath} fetch origin main`.quiet();
  await $`git -C ${config.repoPath} worktree add ${worktree} -b ${branch} origin/main`.quiet();
  // Install deps so the builder can typecheck/test its own work in-worktree.
  await $`bun install`.cwd(worktree).quiet();

  // 2. Run the builder in the worktree (synchronous drive).
  const prompt =
    `Implement the following issue by editing files in the current working directory. ` +
    `Use your tools to make the change, then typecheck/test it. Do NOT run git or open a ` +
    `pull request — the substrate handles version control for you.\n\n` +
    `Issue ${issue.id}: ${issue.title}\n\n${issue.body}`;
  const run = await runAgent(worktree, {
    title: `build ${issue.id}`,
    agent: config.builderAgent,
    prompt,
    mode: "sync",
  });

  // 3. Did the builder actually change anything?
  const status = (await $`git -C ${worktree} status --porcelain`.text()).trim();
  if (!status) {
    return {
      branch,
      worktree,
      changed: false,
      reply: run.reply,
      route: config.builderAgent,
      buildSessionId: run.sessionId,
      tokens: run.tokens,
    };
  }

  // 4. Substrate owns git + GitHub.
  const commitMsg = `feat: ${issue.title} (${issue.id})`;
  await $`git -C ${worktree} add -A`.quiet();
  await $`git -C ${worktree} commit -q -m ${commitMsg}`;
  await $`git -C ${worktree} push -u origin ${branch}`.quiet();
  const prBody =
    `Built by the cheap builder route and dispatched by the substrate.\n\n` +
    `**Issue ${issue.id}:** ${issue.title}\n\n${issue.body}`;
  const prUrl = (
    await $`gh pr create --repo ${config.ghRepo} --head ${branch} --base main --title ${commitMsg} --body ${prBody}`.text()
  ).trim();

  return {
    branch,
    worktree,
    changed: true,
    reply: run.reply,
    prUrl,
    route: config.builderAgent,
    buildSessionId: run.sessionId,
    tokens: run.tokens,
  };
}
