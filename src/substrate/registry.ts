// SQLite-backed dispatch registry for the substrate.
// A dispatch is one issue through build -> review -> PR.
// Uses bun:sqlite (built-in); no external deps.

import { Database } from "bun:sqlite";

export type DispatchState = "queued" | "building" | "review" | "done" | "failed";

export interface DispatchRecord {
  id: string;
  issue_id: string;
  title: string;
  branch: string;
  state: DispatchState;
  build_session_id: string | null;
  review_session_id: string | null;
  pr_url: string | null;
  cost_usd: number | null;
  created_at: number;
  updated_at: number;
}

export type CreateDispatch = Omit<DispatchRecord, "state" | "build_session_id" | "review_session_id" | "pr_url" | "cost_usd" | "created_at" | "updated_at">;

export interface DispatchListFilter {
  state?: DispatchState;
}

export interface SessionLinks {
  buildSessionId?: string;
  reviewSessionId?: string;
}

// Allowed transitions: key is current state, values are valid next states.
const TRANSITIONS: Record<DispatchState, DispatchState[]> = {
  queued: ["building", "failed"],
  building: ["review", "failed"],
  review: ["done", "failed"],
  done: [],
  failed: [],
};

const TERMINAL_STATES: Set<DispatchState> = new Set(["done", "failed"]);

function isTerminal(state: DispatchState): boolean {
  return TERMINAL_STATES.has(state);
}

export class DispatchRegistry {
  private db: Database;

  constructor(dbPath: string = ".orchestrator/dispatches.db") {
    // Ensure parent directory exists
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) {
      // Synchronous mkdir -p using Bun's built-in
      Bun.spawnSync(["mkdir", "-p", dir]);
    }
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        title TEXT NOT NULL,
        branch TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        build_session_id TEXT NULL,
        review_session_id TEXT NULL,
        pr_url TEXT NULL,
        cost_usd REAL NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  create(rec: CreateDispatch): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO dispatches (id, issue_id, title, branch, state, build_session_id, review_session_id, pr_url, cost_usd, created_at, updated_at)
      VALUES ($id, $issue_id, $title, $branch, 'queued', NULL, NULL, NULL, NULL, $created_at, $updated_at)
    `);
    stmt.run({
      $id: rec.id,
      $issue_id: rec.issue_id,
      $title: rec.title,
      $branch: rec.branch,
      $created_at: now,
      $updated_at: now,
    });
  }

  get(id: string): DispatchRecord | null {
    const stmt = this.db.prepare("SELECT * FROM dispatches WHERE id = $id");
    const row = stmt.get({ $id: id }) as DispatchRecord | undefined;
    return row ?? null;
  }

  list(filter?: DispatchListFilter): DispatchRecord[] {
    if (filter?.state) {
      const stmt = this.db.prepare("SELECT * FROM dispatches WHERE state = $state ORDER BY created_at DESC");
      return stmt.all({ $state: filter.state }) as DispatchRecord[];
    }
    const stmt = this.db.prepare("SELECT * FROM dispatches ORDER BY created_at DESC");
    return stmt.all() as DispatchRecord[];
  }

  transition(id: string, toState: DispatchState): void {
    const txn = this.db.transaction(() => {
      const row = this.db.prepare("SELECT state FROM dispatches WHERE id = $id").get({ $id: id }) as { state: string } | undefined;
      if (!row) {
        throw new Error(`Dispatch not found: ${id}`);
      }
      const fromState = row.state as DispatchState;
      const allowed = TRANSITIONS[fromState];
      if (!allowed.includes(toState)) {
        throw new Error(`Illegal transition: ${fromState} -> ${toState}`);
      }
      const now = Date.now();
      this.db.prepare("UPDATE dispatches SET state = $state, updated_at = $updated_at WHERE id = $id").run({
        $state: toState,
        $updated_at: now,
        $id: id,
      });
    });
    txn();
  }

  setSessions(id: string, links: SessionLinks): void {
    if (links.buildSessionId !== undefined) {
      const stmt = this.db.prepare("UPDATE dispatches SET build_session_id = $sid, updated_at = $updated_at WHERE id = $id");
      stmt.run({ $sid: links.buildSessionId, $updated_at: Date.now(), $id: id });
    }
    if (links.reviewSessionId !== undefined) {
      const stmt = this.db.prepare("UPDATE dispatches SET review_session_id = $sid, updated_at = $updated_at WHERE id = $id");
      stmt.run({ $sid: links.reviewSessionId, $updated_at: Date.now(), $id: id });
    }
  }

  setPr(id: string, url: string): void {
    const stmt = this.db.prepare("UPDATE dispatches SET pr_url = $url, updated_at = $updated_at WHERE id = $id");
    stmt.run({ $url: url, $updated_at: Date.now(), $id: id });
  }

  setCost(id: string, usd: number): void {
    const stmt = this.db.prepare("UPDATE dispatches SET cost_usd = $cost, updated_at = $updated_at WHERE id = $id");
    stmt.run({ $cost: usd, $updated_at: Date.now(), $id: id });
  }

  resumeIncomplete(): DispatchRecord[] {
    // Build a query that matches all non-terminal states.
    // Since bun:sqlite doesn't support array params easily, use explicit OR.
    const nonTerminal = ["queued", "building", "review"];
    const placeholders = nonTerminal.map(() => "?").join(",");
    const stmt = this.db.prepare(`SELECT * FROM dispatches WHERE state IN (${placeholders}) ORDER BY created_at DESC`);
    return stmt.all(...nonTerminal) as DispatchRecord[];
  }
}
