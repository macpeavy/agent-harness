// The dispatch registry — durable, crash-recoverable dispatch state (ADR 0009),
// over Drizzle on bun:sqlite (ADR 0016).
//
// A *dispatch* is the substrate's unit of work: one chunk carried through
// build -> review -> amend -> PR. This registry sits ABOVE OpenCode's own session
// store — it links the session ids a dispatch spawned, it does NOT duplicate session
// or message data (that stays in OpenCode's store, read through it when needed).
//
// It is also the cheap-able-fraction instrument: each row records the build route,
// amend rounds, escalation, and per-leg cost, so a corpus of dispatches yields the
// cost-and-quality readouts the thesis verdict needs (ADR 0009 / ADR 0008).
//
// Queries go through Drizzle's typed query builder — no hand-written SQL strings.
// The state machine + the domain types live in ./dispatch; the table in ./schema.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dispatches, type Dispatch, type NewDispatch } from "./schema";
import {
  isTerminal,
  nonTerminalStates,
  TRANSITIONS,
  type CostLeg,
  type DispatchState,
  type Escalation,
} from "./dispatch";

export type { Dispatch };
export { isTerminal, nonTerminalStates, TRANSITIONS };

/** The fields needed to open a new dispatch; everything else defaults. */
export interface CreateDispatch {
  id: string;
  issueId: string;
  title: string;
  branch: string;
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

const DEFAULT_DB_PATH = ".substrate/dispatches.db";
// Migrations are committed source (drizzle/), resolved relative to this file so the
// path holds regardless of the process's working directory.
const MIGRATIONS_DIR = join(import.meta.dir, "../../drizzle");

// rowid DESC tiebreaks dispatches created in the same millisecond, so newest-first is
// deterministic (insertion order) at ms timestamp resolution. rowid is SQLite's
// implicit key, not a modeled column, hence the sql fragment.
const NEWEST_FIRST = [desc(dispatches.createdAt), desc(sql`rowid`)] as const;

export class DispatchRegistry {
  private sqlite: Database;
  private db: BunSQLiteDatabase;

  /** Open (or create) the registry db, enable WAL, and apply pending migrations. */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.run("PRAGMA journal_mode = WAL");
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
  }

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
        state: "queued",
        route: rec.route ?? null,
        amendRounds: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  /** Fetch a dispatch by id, or null if absent. */
  get(id: string): Dispatch | null {
    return this.db.select().from(dispatches).where(eq(dispatches.id, id)).get() ?? null;
  }

  /** List dispatches, newest first, optionally filtered by state. */
  list(filter?: DispatchFilter): Dispatch[] {
    const where = filter?.state ? eq(dispatches.state, filter.state) : undefined;
    return this.db
      .select()
      .from(dispatches)
      .where(where)
      .orderBy(...NEWEST_FIRST)
      .all();
  }

  /**
   * Move a dispatch to a new state, validated against the transition graph and
   * rejected if illegal. The read-validate-write runs inside one transaction, so a
   * concurrent transition can't validate against stale state.
   */
  transition(id: string, to: DispatchState): void {
    this.db.transaction((tx) => {
      const row = tx
        .select({ state: dispatches.state })
        .from(dispatches)
        .where(eq(dispatches.id, id))
        .get();
      if (!row) throw new Error(`no dispatch ${id}`);
      if (!TRANSITIONS[row.state].includes(to))
        throw new Error(`transition: illegal ${row.state} → ${to} for dispatch ${id}`);
      tx.update(dispatches)
        .set({ state: to, updatedAt: Date.now() })
        .where(eq(dispatches.id, id))
        .run();
    });
  }

  /**
   * Escalate a dispatch (cap exceeded, ADR 0008): transition to 'escalated' and
   * record the escalation kind, atomically, in one transaction.
   */
  escalate(id: string, kind: Escalation): void {
    this.db.transaction((tx) => {
      const row = tx
        .select({ state: dispatches.state })
        .from(dispatches)
        .where(eq(dispatches.id, id))
        .get();
      if (!row) throw new Error(`no dispatch ${id}`);
      if (!TRANSITIONS[row.state].includes("escalated"))
        throw new Error(`escalate: illegal ${row.state} → escalated for dispatch ${id}`);
      tx.update(dispatches)
        .set({ state: "escalated", escalated: kind, updatedAt: Date.now() })
        .where(eq(dispatches.id, id))
        .run();
    });
  }

  /**
   * Link OpenCode session ids onto a dispatch. Both ids are set in one UPDATE, so
   * the write is inherently atomic — the spike shipped an atomicity bug by firing
   * two un-transactioned updates here.
   */
  setSessions(id: string, links: SessionLinks): void {
    const patch: Partial<NewDispatch> = {};
    if (links.buildSessionId !== undefined) patch.buildSessionId = links.buildSessionId;
    if (links.reviewSessionId !== undefined) patch.reviewSessionId = links.reviewSessionId;
    if (Object.keys(patch).length === 0) return;
    this.requireExists(id);
    this.db
      .update(dispatches)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(dispatches.id, id))
      .run();
  }

  /** Link a PR url onto a dispatch. */
  setPr(id: string, url: string): void {
    this.requireExists(id);
    this.db
      .update(dispatches)
      .set({ prUrl: url, updatedAt: Date.now() })
      .where(eq(dispatches.id, id))
      .run();
  }

  /** Record (or update) the model route a dispatch built on — the instrument. */
  setRoute(id: string, route: string): void {
    this.requireExists(id);
    this.db
      .update(dispatches)
      .set({ route, updatedAt: Date.now() })
      .where(eq(dispatches.id, id))
      .run();
  }

  /**
   * Record per-leg cost. build/review overwrite that leg; amend accumulates across
   * rounds (a dispatch amends more than once) via an in-place add. The instrument's
   * cost ledger.
   */
  setCost(id: string, leg: CostLeg, usd: number): void {
    this.requireExists(id);
    const now = Date.now();
    if (leg === "amend") {
      this.db
        .update(dispatches)
        .set({
          amendCostUsd: sql`COALESCE(${dispatches.amendCostUsd}, 0) + ${usd}`,
          updatedAt: now,
        })
        .where(eq(dispatches.id, id))
        .run();
      return;
    }
    const patch: Partial<NewDispatch> =
      leg === "build" ? { buildCostUsd: usd } : { reviewCostUsd: usd };
    this.db
      .update(dispatches)
      .set({ ...patch, updatedAt: now })
      .where(eq(dispatches.id, id))
      .run();
  }

  /** Increment the amend-round counter (the decomposition-quality readout). */
  incrementAmendRound(id: string): void {
    this.requireExists(id);
    this.db
      .update(dispatches)
      .set({ amendRounds: sql`${dispatches.amendRounds} + 1`, updatedAt: Date.now() })
      .where(eq(dispatches.id, id))
      .run();
  }

  /**
   * Dispatches in non-terminal states — what the daemon resumes after a restart.
   * The non-terminal set is derived from the transition graph, never hardcoded.
   */
  resumeIncomplete(): Dispatch[] {
    return this.db
      .select()
      .from(dispatches)
      .where(inArray(dispatches.state, nonTerminalStates()))
      .orderBy(...NEWEST_FIRST)
      .all();
  }

  /** Close the underlying db handle. */
  close(): void {
    this.sqlite.close();
  }

  private requireExists(id: string): void {
    const row = this.db.select({ id: dispatches.id }).from(dispatches).where(eq(dispatches.id, id)).get();
    if (!row) throw new Error(`no dispatch ${id}`);
  }
}
