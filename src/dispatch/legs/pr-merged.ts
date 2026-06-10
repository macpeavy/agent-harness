// The PR-merged probe (service layer, AGENT-45) — has the owner merged a session's PR on
// GitHub? The session loop polls this for each in-`review` session so a merge closes the
// session without the owner having to relay it to the chief (`close_session` stays as the
// manual fallback). One `gh pr view` per call; the loop owns the cadence.

import { $ } from "bun";
import type { SubstrateConfig } from "../../config";

/** Whether the PR has been merged. A closed-but-unmerged PR returns false — rejecting a
 *  session PR is the abandon CLI's path, not a completion. */
export async function runPrMergedLeg(prNumber: number, config: SubstrateConfig): Promise<boolean> {
  const { state } = (await $`gh pr view ${prNumber} --repo ${config.ghRepo} --json state`.quiet().json()) as {
    state: string;
  };
  return state === "MERGED";
}
