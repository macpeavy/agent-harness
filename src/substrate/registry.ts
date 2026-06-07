// The dispatch registry — durable, crash-recoverable dispatch state (ADR 0009).
//
// A *dispatch* is the substrate's unit of work: one chunk of work carried through
// build -> review -> amend -> PR. This registry sits ABOVE OpenCode's own session
// store — it links the session ids a dispatch spawned, it does NOT duplicate session
// or message data (that stays in OpenCode's store, read through it when needed).
//
// It is also the cheap-able-fraction instrument: each row records the build route,
// amend rounds, escalation, and per-leg cost, so a corpus of dispatches yields the
// cost-and-quality readouts the thesis verdict needs (ADR 0009 / ADR 0008).
//
// bun:sqlite, no ORM, no deps. Prepared statements throughout; every multi-statement
// mutation is wrapped in a transaction (the state + updated_at write is one atomic
// unit). See the persistence-bun-sqlite skill.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A dispatch's lifecycle state. Terminal states have no outgoing transitions. */
export type DispatchState =
  | "queued"
  | "building"
  | "review"
  | "amending"
  | "done"
  | "escalated"
  | "failed";

/** Where a cap-exceeded dispatch was escalated (the ADR 0008 ladder). */
export type Escalation = "re-decompose" | "tier-promote" | "attended";

/** The legs a dispatch's cost is split across (the instrument). */
export type CostLeg = "build" | "review" | "amend";

/**
 * The allowed state graph (ADR 0009). A state whose array is empty is terminal —
 * the terminal/non-terminal sets are DERIVED from this, never hardcoded.
 */
export const TRANSITIONS: Record<DispatchState, DispatchState[]> = {
  queued: ["building"],
  building: ["review", "escalated", "failed"],
  review: ["amending", "done", "escalated", "failed"],
  amending: ["review", "escalated", "failed"],
  done: [],
  escalated: [],
  failed: [],
};

/** A state is terminal when it has no outgoing transitions. */
export function isTerminal(state: DispatchState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** The non-terminal states, derived from the transition graph. */
export function nonTerminalStates(): DispatchState[] {
  return (Object.keys(TRANSITIONS) as DispatchState[]).filter((s) => !isTerminal(s));
}

/** The typed domain model of a dispatch row. */
export interface Dispatch {
  id: string;
  issueId: string;
  title: string;
  branch: string;
  state: DispatchState;
  buildSessionId: string | null;
  reviewSessionId: string | null;
  prUrl: string | null;
  route: string | null;
  amendRounds: number;
  escalated: Escalation | null;
  buildCostUsd: number | null;
  reviewCostUsd: number | null;
  amendCostUsd: number | null;
  createdAt: number;
  updatedAt: number;
}

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

// The raw row shape as it comes back from SQLite — snake_case columns, untyped at
// runtime. Mapped to the camelCase Dispatch model with every field defaulted, per
// docs/standards.md § Typed boundaries (the spike cast raw rows with a bare `as`).
interface DispatchRow {
  id?: string;
  issue_id?: string;
  title?: string;
  branch?: string;
  state?: string;
  build_session_id?: string | null;
  review_session_id?: string | null;
  pr_url?: string | null;
  route?: string | null;
  amend_rounds?: number;
  escalated?: string | null;
  build_cost_usd?: number | null;
  review_cost_usd?: number | null;
  amend_cost_usd?: number | null;
  created_at?: number;
  updated_at?: number;
}

function rowToDispatch(row: DispatchRow): Dispatch {
  return {
    id: row.id ?? "",
    issueId: row.issue_id ?? "",
    title: row.title ?? "",
    branch: row.branch ?? "",
    state: (row.state as DispatchState) ?? "queued",
    buildSessionId: row.build_session_id ?? null,
    reviewSessionId: row.review_session_id ?? null,
    prUrl: row.pr_url ?? null,
    route: row.route ?? null,
    amendRounds: row.amend_rounds ?? 0,
    escalated: (row.escalated as Escalation | null) ?? null,
    buildCostUsd: row.build_cost_usd ?? null,
    reviewCostUsd: row.review_cost_usd ?? null,
    amendCostUsd: row.amend_cost_usd ?? null,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0,
  };
}

const DEFAULT_DB_PATH = ".substrate/dispatches.db";

export class DispatchRegistry {
  private db: Database;

  /** Open (or create) the registry db, enable WAL, and ensure the schema exists. */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dispatches (
        id               TEXT PRIMARY KEY,
        issue_id         TEXT NOT NULL,
        title            TEXT NOT NULL,
        branch           TEXT NOT NULL,
        state            TEXT NOT NULL DEFAULT 'queued',
        build_session_id TEXT,
        review_session_id TEXT,
        pr_url           TEXT,
        route            TEXT,
        amend_rounds     INTEGER NOT NULL DEFAULT 0,
        escalated        TEXT,
        build_cost_usd   REAL,
        review_cost_usd  REAL,
        amend_cost_usd   REAL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      )
    `);
  }

  /** Insert a new dispatch in state 'queued'. Throws if the id already exists. */
  create(rec: CreateDispatch): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO dispatches (id, issue_id, title, branch, state, route, amend_rounds, created_at, updated_at)
         VALUES ($id, $issue_id, $title, $branch, 'queued', $route, 0, $now, $now)`,
      )
      .run({
        $id: rec.id,
        $issue_id: rec.issueId,
        $title: rec.title,
        $branch: rec.branch,
        $route: rec.route ?? null,
        $now: now,
      });
  }

  /** Fetch a dispatch by id, or null if absent. */
  get(id: string): Dispatch | null {
    const row = this.db.query("SELECT * FROM dispatches WHERE id = $id").get({ $id: id }) as
      | DispatchRow
      | null;
    return row ? rowToDispatch(row) : null;
  }

  /** List dispatches, newest first, optionally filtered by state. */
  list(filter?: DispatchFilter): Dispatch[] {
    // rowid DESC tiebreaks dispatches created in the same millisecond, so
    // newest-first is deterministic (insertion order) at ms timestamp resolution.
    const rows = filter?.state
      ? (this.db
          .query("SELECT * FROM dispatches WHERE state = $state ORDER BY created_at DESC, rowid DESC")
          .all({ $state: filter.state }) as DispatchRow[])
      : (this.db
          .query("SELECT * FROM dispatches ORDER BY created_at DESC, rowid DESC")
          .all() as DispatchRow[]);
    return rows.map(rowToDispatch);
  }

  /**
   * Move a dispatch to a new state, validated against the transition graph and
   * rejected if illegal. The state + updated_at write is wrapped in a transaction.
   */
  transition(id: string, to: DispatchState): void {
    this.db.transaction(() => {
      const from = this.requireState(id);
      if (!TRANSITIONS[from].includes(to))
        throw new Error(`transition: illegal ${from} → ${to} for dispatch ${id}`);
      this.db
        .query("UPDATE dispatches SET state = $to, updated_at = $now WHERE id = $id")
        .run({ $to: to, $now: Date.now(), $id: id });
    })();
  }

  /**
   * Escalate a dispatch (cap exceeded, ADR 0008): transition to 'escalated' and
   * record the escalation kind, atomically, in one transaction.
   */
  escalate(id: string, kind: Escalation): void {
    this.db.transaction(() => {
      const from = this.requireState(id);
      if (!TRANSITIONS[from].includes("escalated"))
        throw new Error(`escalate: illegal ${from} → escalated for dispatch ${id}`);
      this.db
        .query(
          "UPDATE dispatches SET state = 'escalated', escalated = $kind, updated_at = $now WHERE id = $id",
        )
        .run({ $kind: kind, $now: Date.now(), $id: id });
    })();
  }

  /**
   * Link OpenCode session ids onto a dispatch. When both ids are given the two
   * column writes are one atomic unit — the spike shipped an atomicity bug here.
   */
  setSessions(id: string, links: SessionLinks): void {
    this.requireExists(id);
    this.db.transaction(() => {
      const now = Date.now();
      if (links.buildSessionId !== undefined)
        this.db
          .query("UPDATE dispatches SET build_session_id = $sid, updated_at = $now WHERE id = $id")
          .run({ $sid: links.buildSessionId, $now: now, $id: id });
      if (links.reviewSessionId !== undefined)
        this.db
          .query("UPDATE dispatches SET review_session_id = $sid, updated_at = $now WHERE id = $id")
          .run({ $sid: links.reviewSessionId, $now: now, $id: id });
    })();
  }

  /** Link a PR url onto a dispatch. */
  setPr(id: string, url: string): void {
    this.requireExists(id);
    this.db
      .query("UPDATE dispatches SET pr_url = $url, updated_at = $now WHERE id = $id")
      .run({ $url: url, $now: Date.now(), $id: id });
  }

  /** Record (or update) the model route a dispatch built on — the instrument. */
  setRoute(id: string, route: string): void {
    this.requireExists(id);
    this.db
      .query("UPDATE dispatches SET route = $route, updated_at = $now WHERE id = $id")
      .run({ $route: route, $now: Date.now(), $id: id });
  }

  /**
   * Record per-leg cost. build/review overwrite that leg; amend accumulates across
   * rounds (a dispatch amends more than once). The instrument's cost ledger.
   */
  setCost(id: string, leg: CostLeg, usd: number): void {
    this.requireExists(id);
    const now = Date.now();
    if (leg === "amend") {
      this.db
        .query(
          "UPDATE dispatches SET amend_cost_usd = COALESCE(amend_cost_usd, 0) + $usd, updated_at = $now WHERE id = $id",
        )
        .run({ $usd: usd, $now: now, $id: id });
      return;
    }
    const column = leg === "build" ? "build_cost_usd" : "review_cost_usd";
    this.db
      .query(`UPDATE dispatches SET ${column} = $usd, updated_at = $now WHERE id = $id`)
      .run({ $usd: usd, $now: now, $id: id });
  }

  /** Increment the amend-round counter (the decomposition-quality readout). */
  incrementAmendRound(id: string): void {
    this.requireExists(id);
    this.db
      .query(
        "UPDATE dispatches SET amend_rounds = amend_rounds + 1, updated_at = $now WHERE id = $id",
      )
      .run({ $now: Date.now(), $id: id });
  }

  /**
   * Dispatches in non-terminal states — what the daemon resumes after a restart.
   * The non-terminal set is derived from the transition graph, never hardcoded.
   */
  resumeIncomplete(): Dispatch[] {
    const states = nonTerminalStates();
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT * FROM dispatches WHERE state IN (${placeholders}) ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...states) as DispatchRow[];
    return rows.map(rowToDispatch);
  }

  /** Close the underlying db handle. */
  close(): void {
    this.db.close();
  }

  // Read the current state of a dispatch, throwing if it does not exist. Used
  // inside transition/escalate transactions so the existence check and the write
  // share one atomic unit.
  private requireState(id: string): DispatchState {
    const row = this.db.query("SELECT state FROM dispatches WHERE id = $id").get({ $id: id }) as
      | { state?: string }
      | null;
    if (!row) throw new Error(`no dispatch ${id}`);
    return (row.state as DispatchState) ?? "queued";
  }

  private requireExists(id: string): void {
    const row = this.db.query("SELECT 1 FROM dispatches WHERE id = $id").get({ $id: id });
    if (!row) throw new Error(`no dispatch ${id}`);
  }
}
