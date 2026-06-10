// The session-PR probe (service layer, AGENT-45 + the CI leg) — what GitHub knows about an
// in-`review` session's PR that the substrate can't see from DB state: did the owner merge
// it, and did its checks fail? One `gh pr view` per call reads both; the session loop owns
// the cadence. On merge the loop closes the session; on a concluded check failure it records
// the failing head so the notify pass can wake the chief to route a fix (amend_chunk).

import { $ } from "bun";
import type { SubstrateConfig } from "../../config";

/** What one probe of the session PR concluded. */
export interface PrProbe {
  /** The owner merged the PR. A closed-but-unmerged PR is false — rejecting a session PR
   *  is the abandon CLI's path, not a completion. */
  merged: boolean;
  /** The PR's current head commit, when reported. */
  headSha: string | null;
  /** Names of checks that CONCLUDED in failure on that head. Pending/queued checks are not
   *  failures yet — the next probe sees their conclusion. Empty = green, pending, or no CI. */
  failedChecks: string[];
}

// The rollup item shapes gh returns: CheckRun (GitHub Actions et al) carries name +
// status/conclusion; StatusContext (commit statuses) carries context + state.
interface RollupItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

/**
 * The check names that concluded in failure, from a `statusCheckRollup` payload. Pure, so
 * the conclusion taxonomy is unit-testable: a CheckRun fails on FAILURE/TIMED_OUT (CANCELLED
 * is excluded — it usually means a superseding push, not a verdict); a StatusContext fails
 * on FAILURE/ERROR. Anything pending or successful is not a failure.
 */
export function failedChecksFrom(rollup: RollupItem[] | null | undefined): string[] {
  const failed: string[] = [];
  for (const item of rollup ?? []) {
    const name = item.name ?? item.context ?? "unnamed check";
    if (item.conclusion === "FAILURE" || item.conclusion === "TIMED_OUT") failed.push(name);
    else if (item.state === "FAILURE" || item.state === "ERROR") failed.push(name);
  }
  return failed;
}

/** Probe the PR's merged state + concluded check failures (one gh call). */
export async function runPrProbeLeg(prNumber: number, config: SubstrateConfig): Promise<PrProbe> {
  const view = (await $`gh pr view ${prNumber} --repo ${config.ghRepo} --json state,headRefOid,statusCheckRollup`
    .quiet()
    .json()) as { state: string; headRefOid?: string; statusCheckRollup?: RollupItem[] };

  return {
    merged: view.state === "MERGED",
    headSha: view.headRefOid ?? null,
    failedChecks: failedChecksFrom(view.statusCheckRollup),
  };
}
