// The build leg (service layer) — dispatch one issue to the cheap builder.
//
// Given an issue and the substrate config, it: creates an isolated git worktree on a
// fresh branch off origin/main, dispatches the builder agent (cheap route) to
// implement it — driven over HTTP against an `opencode serve` bound to that worktree —
// then, if the builder changed anything, commits the diff, pushes, and opens a PR.
// The substrate owns git + GitHub; the agent owns the code. It returns its result;
// the daemon (AGENT-19) persists the transitions via the repository — the leg holds
// no registry/SQL.

import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OpencodeClient } from "../opencode/client";
import { startServe } from "../opencode/serve";
import type { SubstrateConfig } from "../config";

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
  tokens: { input: number; output: number };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function runBuildLeg(issue: Issue, config: SubstrateConfig): Promise<BuildResult> {
  const id = issue.id.toLowerCase();
  const branch = `agent/${id}-${slugify(issue.title)}`;
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

  // 2. Dispatch the builder over HTTP (serve bound to the worktree, free port).
  const serve = await startServe(worktree);
  let reply = "";
  let tokens = { input: 0, output: 0 };
  try {
    const client = new OpencodeClient(serve.baseUrl);
    const sessionID = await client.createSession({
      title: `build ${issue.id}`,
      agent: config.builderAgent,
    });
    const prompt =
      `Implement the following issue by editing files in the current working directory. ` +
      `Use your tools to make the change, then typecheck/test it. Do NOT run git or open a ` +
      `pull request — the substrate handles version control for you.\n\n` +
      `Issue ${issue.id}: ${issue.title}\n\n${issue.body}`;
    reply = (await client.sendMessage(sessionID, prompt)).text;
    tokens = await client.sessionTokens(sessionID);
  } finally {
    serve.stop();
  }

  // 3. Did the builder actually change anything?
  const status = (await $`git -C ${worktree} status --porcelain`.text()).trim();
  if (!status) {
    return { branch, worktree, changed: false, reply, route: config.builderAgent, tokens };
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

  return { branch, worktree, changed: true, reply, prUrl, route: config.builderAgent, tokens };
}
