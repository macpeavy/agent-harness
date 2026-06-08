// One-shot substrate DB migrator (ADR 0016 refinement) — apply the shared migration set ONCE,
// up front, so the long-running processes don't migrate-on-construct.
//
// Why this exists: PlanRepository and DispatchRepository migrate in their constructor, which is
// fine for a single process. But `make up` launches the daemon + session-loop (and the chief's
// MCP server) together, and they all open the one shared SQLite db — two processes migrating it
// at once race, and one exits 1. So `make up` runs `make migrate` (this) before launching the
// panes, and the daemon + session-loop open the db with `{ migrate: false }`, assuming it's
// already current. A standalone tool or a fresh dev run still self-migrates.
//
// Both repos open the same db file and share one migration set, so migrating via each — in this
// one process, sequentially — brings the whole file current with no cross-process race. Run:
//   bun run migrate            (or `make migrate`)   — uses SUBSTRATE_DB or the default path.

import { PlanRepository } from "./plan";
import { DispatchRepository } from "./dispatch";

/** Apply the shared substrate migration set once (both contexts' tables live in the one db). */
export function migrateSubstrate(dbPath?: string): void {
  // migrate-on-construct (the default) does the work; sequential opens in one process can't race.
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  plan.close();
  const dispatch = dbPath ? new DispatchRepository(dbPath) : new DispatchRepository();
  dispatch.close();
}

if (import.meta.main) {
  migrateSubstrate(process.env.SUBSTRATE_DB);
  console.log("substrate db migrated");
}
