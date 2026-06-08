// The one-shot migrator + the migrate:false open path (ADR 0016 refinement). The original
// crash was a CROSS-PROCESS race — `make up` co-launches the daemon + session-loop and both
// migrated the same SQLite db on construct, so one exited 1. The fix migrates once up front
// and opens the long-running processes against the already-migrated db. These tests cover the
// fix's contract (a true two-process race isn't deterministically reproducible in-process).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSubstrate } from "./migrate";
import { PlanRepository } from "./plan";
import { DispatchRepository } from "./dispatch";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-migrate-"));
  dbPath = join(dir, "substrate.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrateSubstrate (one-shot, ADR 0016 refinement)", () => {
  it("migrates both contexts' tables in one pass — repos then open with migrate:false and work", () => {
    migrateSubstrate(dbPath); // the `make migrate` step

    // The make-up path: the long-running processes open the migrated db WITHOUT migrating.
    const plan = new PlanRepository(dbPath, { migrate: false });
    const dispatch = new DispatchRepository(dbPath, { migrate: false });
    try {
      // Both contexts' schemas are present (one migration set covered the shared db).
      plan.createFeature({ id: "F1", title: "A feature", description: "intent" });
      expect(plan.getFeature("F1")?.id).toBe("F1");

      dispatch.create({ id: "d1", issueId: "i1", title: "t", branch: "b", spec: "s" });
      expect(dispatch.get("d1")?.id).toBe("d1");
    } finally {
      plan.close();
      dispatch.close();
    }
  });

  it("is idempotent — running it twice against the same db doesn't throw", () => {
    migrateSubstrate(dbPath);
    expect(() => migrateSubstrate(dbPath)).not.toThrow();
  });

  it("lets the daemon + session-loop repos co-open the migrated db (no migrate-on-construct race)", () => {
    migrateSubstrate(dbPath);

    // session-loop opens a plan + dispatch repo; the daemon opens a dispatch repo — all against
    // the one db, none migrating. The original crash was these migrating concurrently.
    const loopPlan = new PlanRepository(dbPath, { migrate: false });
    const loopDispatch = new DispatchRepository(dbPath, { migrate: false });
    const daemonDispatch = new DispatchRepository(dbPath, { migrate: false });
    try {
      loopDispatch.create({ id: "d1", issueId: "i1", title: "t", branch: "b", spec: "s" });
      expect(daemonDispatch.get("d1")?.id).toBe("d1"); // sees the same db
      expect(loopPlan.listAllSessions()).toEqual([]); // plan schema present, empty
    } finally {
      loopPlan.close();
      loopDispatch.close();
      daemonDispatch.close();
    }
  });

  it("a migrate:false repo on an UN-migrated db has no tables — documents why migrate runs first", () => {
    // No migrateSubstrate call: the db is empty. Opening without migrating then querying fails
    // (no schema). This is the contract the `make migrate` step satisfies before the panes open.
    const dispatch = new DispatchRepository(dbPath, { migrate: false });
    try {
      expect(() => dispatch.get("d1")).toThrow();
    } finally {
      dispatch.close();
    }
  });
});
