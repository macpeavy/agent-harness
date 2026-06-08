// The abandon CLI (the operator kill switch, ADR 0009/0019) — "kill this feature", the thing
// the terminal reaper (which only sweeps already-dead sessions) doesn't cover. Transitions a
// feature + its sessions + chunks + their dispatches to terminal `abandoned`, then closes each
// open session PR and deletes its branch on GitHub. Idempotent: re-running on an abandoned
// feature is a no-op (so it's safe to re-run after a partial GitHub failure).
//
// Run:  bun run src/cli/abandon.ts <featureId>   (or `make abandon FEATURE=<id>`; needs env)

import { $ } from "bun";
import { loadConfig } from "../config";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanRepository } from "../substrate/plan";
import { PlanDispatchService } from "../dispatch/plan-dispatch";

if (import.meta.main) {
  const featureId = process.argv[2];
  if (!featureId) {
    console.error("usage: bun run src/cli/abandon.ts <featureId>");
    process.exit(1);
  }

  const config = await loadConfig();
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  const dispatch = dbPath ? new DispatchRepository(dbPath) : new DispatchRepository();
  const service = new PlanDispatchService(plan, dispatch);

  try {
    const result = service.abandonFeature(featureId);
    if (result.alreadyAbandoned) {
      console.log(`Feature ${featureId} is already abandoned — nothing to do.`);
    } else {
      // Close each open session PR (and delete its head branch) on GitHub. Idempotent via
      // .nothrow — an already-closed/merged PR or an already-gone branch is fine on a re-run.
      for (const s of result.sessions) {
        if (s.prNumber != null) {
          await $`gh pr close ${s.prNumber} --repo ${config.ghRepo} --delete-branch`.nothrow().quiet();
        } else if (s.branch) {
          await $`git -C ${config.repoPath} push origin --delete ${s.branch}`.nothrow().quiet();
        }
      }
      console.log(
        `Abandoned feature ${featureId}: ${result.sessions.length} session(s), ` +
          `${result.dispatchesAbandoned} dispatch(es) → abandoned; open PRs closed + branches deleted.`,
      );
    }
  } finally {
    plan.close();
    dispatch.close();
  }
}
