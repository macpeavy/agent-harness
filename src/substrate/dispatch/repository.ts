// The dispatch repository (the data-access layer, ADR 0009) — the only code that
// touches the database, over Drizzle on bun:sqlite (ADR 0016).
//
// A *dispatch* is the substrate's unit of work: one chunk carried through
// build -> review -> amend -> PR. The repository sits ABOVE OpenCode's own session
// store — it links the session ids a dispatch spawned, it does NOT duplicate session
// or message data (that stays in OpenCode's store, read through it when needed).
//
// It is also the cheap-able-fraction instrument: each row records the build route,
// amend rounds, escalation, and per-leg cost, so a corpus of dispatches yields the
// cost-and-quality readouts the thesis verdict needs (ADR 0009 / ADR 0008).
//
// Queries go through Drizzle's typed query builder — no hand-written SQL strings. The
// state machine and the domain types live in ./model; the table in ./schema.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { dispatches, type Dispatch } from "./schema";
import {
  TRANSITIONS,
  nonTerminalStates,
  type CostLeg,
  type DispatchState,
  type Escalation,
} from "./model";

/** The fields needed to open a new dispatch; everything else defaults. */
export interface CreateDispatch {
  id: string;
  issueId: string;
  title: string;
  branch: string;
  /** The build spec — the issue body the builder works from. */
  spec: string;
  route?: string;
}

/** OpenCode session ids a dispatch links to (it does not own the sessions). */
export interface SessionLinks {
  buildSessionId?: string;
  reviewSessionId?: string;
}

/** Optional filter for `list`. */
export interface DispatchFilter {
  state?: DispatchState;
}

// The column writes an UPDATE accepts — plain values or a bound sql expression (the
// in-place cost add and amend-round bump). Drizzle's set-source for the dispatch table.
type DispatchUpdate = SQLiteUpdateSetSource<typeof dispatches>;

// --- repository configuration ---

const DEFAULT_DB_PATH = ".substrate/dispatches.db";

// Migrations are committed source (drizzle/), resolved relative to this file so the
// path holds regardless of the process's working directory.
const MIGRATIONS_DIR = join(import.meta.dir, "../../../drizzle");

// Newest first, with rowid breaking ties between rows created in the same millisecond.
// rowid is SQLite's implicit key, not a modeled column — hence the sql fragment.
const NEWEST_FIRST = [desc(dispatches.createdAt), desc(sql`rowid`)] as const;

export class DispatchRepository {
  private sqlite: Database;
  private db: BunSQLiteDatabase;

  /** Open (or create) the db, enable WAL, and apply pending migrations. */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });

    this.sqlite = new Database(dbPath);
    this.sqlite.run("PRAGMA journal_mode = WAL");
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
  }

  // --- reads ---

  /** Fetch a dispatch by id, or null if absent. */
  get(id: string): Dispatch | null {
    return this.selectAll().where(eq(dispatches.id, id)).get() ?? null;
  }

  /** List dispatches, newest first, optionally filtered by state. */
  list(filter?: DispatchFilter): Dispatch[] {
    const where = filter?.state ? eq(dispatches.state, filter.state) : undefined;
    return this.selectAll().where(where).orderBy(...NEWEST_FIRST).all();
  }

  /**
   * Dispatches in non-terminal states — what the daemon resumes after a restart.
   * The non-terminal set is derived from the transition graph, never hardcoded.
   */
  resumeIncomplete(): Dispatch[] {
    const incomplete = inArray(dispatches.state, nonTerminalStates());
    return this.selectAll().where(incomplete).orderBy(...NEWEST_FIRST).all();
  }

  // --- writes ---

  /** Insert a new dispatch in state 'queued'. Throws if the id already exists. */
  create(rec: CreateDispatch): void {
    const now = Date.now();
    this.db
      .insert(dispatches)
      .values({
        id: rec.id,
        issueId: rec.issueId,
        title: rec.title,
        branch: rec.branch,
        spec: rec.spec,
        state: "queued",
        route: rec.route ?? null,
        amendRounds: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  /** Move a dispatch to a new state, rejected if the graph disallows it. */
  transition(id: string, to: DispatchState): void {
    this.move(id, to, {});
  }

  /**
   * Escalate a dispatch (cap exceeded, ADR 0008): move to 'escalated' and record the
   * escalation kind in the same atomic step.
   */
  escalate(id: string, kind: Escalation): void {
    this.move(id, "escalated", { escalated: kind });
  }

  /** Link OpenCode session ids onto a dispatch (one atomic UPDATE). */
  setSessions(id: string, links: SessionLinks): void {
    const values: DispatchUpdate = {};
    if (links.buildSessionId !== undefined) values.buildSessionId = links.buildSessionId;
    if (links.reviewSessionId !== undefined) values.reviewSessionId = links.reviewSessionId;

    if (Object.keys(values).length === 0) return;
    this.patch(id, values);
  }

  /** Link a PR url onto a dispatch. */
  setPr(id: string, url: string): void {
    this.patch(id, { prUrl: url });
  }

  /** Record (or update) the model route a dispatch built on — the instrument. */
  setRoute(id: string, route: string): void {
    this.patch(id, { route });
  }

  /**
   * Add to a leg's cost (in-place, so it's race-free). Every leg accumulates: the amend
   * cycle re-reviews and re-amends, so review and amend each run more than once; build
   * runs once, so its accumulation is just the one value. The cost ledger.
   */
  setCost(id: string, leg: CostLeg, usd: number): void {
    switch (leg) {
      case "build":
        this.patch(id, { buildCostUsd: sql`COALESCE(${dispatches.buildCostUsd}, 0) + ${usd}` });
        return;
      case "review":
        this.patch(id, { reviewCostUsd: sql`COALESCE(${dispatches.reviewCostUsd}, 0) + ${usd}` });
        return;
      case "amend":
        this.patch(id, { amendCostUsd: sql`COALESCE(${dispatches.amendCostUsd}, 0) + ${usd}` });
        return;
    }
  }

  /** Increment the amend-round counter (the decomposition-quality readout). */
  incrementAmendRound(id: string): void {
    this.patch(id, { amendRounds: sql`${dispatches.amendRounds} + 1` });
  }

  /** Close the underlying db handle. */
  close(): void {
    this.sqlite.close();
  }

  // --- internals ---

  // The base SELECT * for the read methods, so they read as intent, not builder chains.
  private selectAll() {
    return this.db.select().from(dispatches);
  }

  // Validate a state move against the graph inside a transaction, then apply the
  // caller's extra column writes. One place owns the existence + legality checks, so
  // the read-validate-write can't race a concurrent writer.
  private move(id: string, to: DispatchState, extra: DispatchUpdate): void {
    this.db.transaction((tx) => {
      const current = tx
        .select({ state: dispatches.state })
        .from(dispatches)
        .where(eq(dispatches.id, id))
        .get();

      if (!current) {
        throw new Error(`no dispatch ${id}`);
      }
      if (!TRANSITIONS[current.state].includes(to)) {
        throw new Error(`illegal transition ${current.state} → ${to} for dispatch ${id}`);
      }

      tx.update(dispatches)
        .set({ ...extra, state: to, updatedAt: Date.now() })
        .where(eq(dispatches.id, id))
        .run();
    });
  }

  // Apply a partial column write to an existing dispatch, stamping updated_at. Throws
  // if the dispatch is absent (a link onto a missing row is a caller bug, not a no-op).
  private patch(id: string, values: DispatchUpdate): void {
    this.requireExists(id);
    this.db
      .update(dispatches)
      .set({ ...values, updatedAt: Date.now() })
      .where(eq(dispatches.id, id))
      .run();
  }

  private requireExists(id: string): void {
    const row = this.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(eq(dispatches.id, id))
      .get();

    if (!row) throw new Error(`no dispatch ${id}`);
  }
}
