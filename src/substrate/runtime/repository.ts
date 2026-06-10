// The runtime repository (the data-access layer, ADR 0024) — the only code that touches
// the runtime tables, over Drizzle on the shared substrate db (ADR 0016/0017). Holds the
// chief-session registration the session loop's notify pass addresses its wake to.
// Runtime-only: it does not depend on the plan or dispatch repositories.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { chiefRegistrations, type ChiefRegistration } from "./schema";

/** Register the live chief — its OpenCode session id and the server it lives on. */
export interface RegisterChief {
  sessionId: string;
  baseUrl: string;
}

// The shared substrate db and the committed migration set, resolved relative to this file
// so the path holds regardless of cwd (same convention as the plan/dispatch repositories).
const DEFAULT_DB_PATH = ".substrate/substrate.db";
const MIGRATIONS_DIR = join(import.meta.dir, "../../../drizzle");

// The singleton registration row's id — one chief at a time (ADR 0024); a re-launch
// replaces the row rather than accumulating stale addresses.
const CHIEF_ROW_ID = "chief";

export class RuntimeRepository {
  private sqlite: Database;
  private db: BunSQLiteDatabase;

  /**
   * Open (or create) the shared db, enable WAL + FK enforcement, and (by default) apply
   * migrations. `opts.migrate: false` skips the migrate-on-construct for a process that a
   * shared launch (`make up`) co-starts with others against the same db — the launch
   * migrates once up front (`make migrate`), per ADR 0016's refinement.
   */
  constructor(dbPath: string = DEFAULT_DB_PATH, opts: { migrate?: boolean } = {}) {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });

    this.sqlite = new Database(dbPath);
    this.sqlite.run("PRAGMA journal_mode = WAL");
    this.sqlite.run("PRAGMA foreign_keys = ON");
    this.sqlite.run("PRAGMA busy_timeout = 5000");
    this.db = drizzle(this.sqlite);
    if (opts.migrate !== false) migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
  }

  /**
   * Register the live chief, replacing any prior registration (one chief at a time —
   * a re-launch overwrites the stale address rather than erroring on it).
   */
  registerChief(rec: RegisterChief): void {
    this.db
      .insert(chiefRegistrations)
      .values({ id: CHIEF_ROW_ID, sessionId: rec.sessionId, baseUrl: rec.baseUrl, registeredAt: Date.now() })
      .onConflictDoUpdate({
        target: chiefRegistrations.id,
        set: { sessionId: rec.sessionId, baseUrl: rec.baseUrl, registeredAt: Date.now() },
      })
      .run();
  }

  /** The live chief's registration, or null if none is registered. */
  getChief(): ChiefRegistration | null {
    return this.db.select().from(chiefRegistrations).where(eq(chiefRegistrations.id, CHIEF_ROW_ID)).get() ?? null;
  }

  /**
   * Clear the chief registration — but only if it still belongs to `sessionId`. The
   * launcher calls this on exit; the guard keeps a slow-exiting old chief from wiping a
   * newer launch's registration (the replace-on-register already retired the old row).
   */
  clearChief(sessionId: string): void {
    this.db
      .delete(chiefRegistrations)
      .where(and(eq(chiefRegistrations.id, CHIEF_ROW_ID), eq(chiefRegistrations.sessionId, sessionId)))
      .run();
  }

  /** Close the underlying db handle. */
  close(): void {
    this.sqlite.close();
  }
}
