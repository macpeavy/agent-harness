// The owner's first gate (ADR 0019): approve a decomposed feature for dispatch, moving it
// planning → ready. `dispatch` already refuses anything not 'ready', so this transition is
// what unlocks the build loop.
//
// Deliberately a CLI the OWNER runs — NOT an MCP tool. The chief reaches the substrate only
// through its MCP toolset (decompose/dispatch/status) and has no bash, so it can neither
// call an approve tool (there isn't one) nor run this script: the chief cannot self-approve,
// by construction. Authority stays with the owner.
//
// Run:  bun run src/cli/approve.ts <featureId>

import { PlanRepository } from "../substrate/plan";

/**
 * Approve a feature for dispatch (planning → ready). Throws a clear error if the feature is
 * absent or not awaiting approval (already approved / building / done). Pure of process
 * concerns so it's unit-testable; the CLI below wraps it.
 */
export function approveFeature(plan: PlanRepository, featureId: string): void {
  const feature = plan.getFeature(featureId);
  if (!feature) throw new Error(`no feature ${featureId}`);
  if (feature.state !== "planning")
    throw new Error(`feature ${featureId} is not awaiting approval (state: ${feature.state})`);
  plan.transitionFeature(featureId, "ready");
}

if (import.meta.main) {
  const featureId = process.argv[2];
  if (!featureId) {
    console.error("usage: bun run src/cli/approve.ts <featureId>");
    process.exit(2);
  }

  // SUBSTRATE_DB overrides the default shared-db path (mirrors the MCP server), so a test or
  // a non-default deployment can point the CLI at a specific db.
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  try {
    approveFeature(plan, featureId);
    const feature = plan.getFeature(featureId);
    const chunkCount = plan.listChunks(featureId).length;
    console.log(`Approved feature ${featureId} "${feature?.title}" (${chunkCount} chunks) — ready for dispatch.`);
  } catch (err) {
    console.error(`approve failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    plan.close();
  }
}
