// The terminal-reaper CLI (the janitor entrypoint, ADR 0009/0019) — one sweep that deletes
// abandoned OpenCode sessions and dangling remote branches left by terminal/superseded
// dispatches. Run periodically (or by hand) alongside the daemon.
//
// Sessions live in OpenCode's on-disk store, reachable only over an `opencode serve`, and
// there's no long-lived one (each build spins an ephemeral serve). So the CLI spins its own
// ephemeral serve, issues the deletes, and stops it. Branch deletes go through git.
//
// Run:  bun run src/cli/reap.ts   (needs env: source .env)

import { $ } from "bun";
import { loadConfig } from "../config";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanRepository } from "../substrate/plan";
import { OpencodeClient } from "../opencode/client";
import { startServe } from "../opencode/serve";
import { Reaper, type ReapDeps } from "../dispatch/reaper";

if (import.meta.main) {
  const config = await loadConfig();
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  const dispatch = dbPath ? new DispatchRepository(dbPath) : new DispatchRepository();

  // An ephemeral serve over the shared session store, just to issue the DELETEs.
  const serve = await startServe(config.repoPath);
  const client = new OpencodeClient(serve.baseUrl);
  const deps: ReapDeps = {
    deleteSession: (id) => client.deleteSession(id),
    // The branch is pushed to origin; --delete removes it there. .nothrow: an already-gone
    // branch (a prior sweep, or never pushed) is a no-op.
    deleteBranch: async (branch) => {
      await $`git -C ${config.repoPath} push origin --delete ${branch}`.nothrow().quiet();
    },
  };

  try {
    const result = await new Reaper(plan, dispatch, deps).reap();
    console.log(
      `Reaped ${result.dispatchesReaped} dispatch(es): ` +
        `${result.sessionsReaped} session(s), ${result.branchesReaped} branch(es).`,
    );
  } finally {
    serve.stop();
    plan.close();
    dispatch.close();
  }
}
