// The plan repository (the data-access layer, ADR 0019/0020) — the only code that touches
// the plan tables, over Drizzle on the shared substrate db (ADR 0016/0017). Plan-only:
// it does NOT depend on the dispatch repository. Binding the two contexts (filling a
// dispatch's spec from a chunk, reading a dispatch outcome) is the service layer's job;
// here `linkDispatch`/`recordOutcome` take what the service hands them.
//
// Two-level structure (ADR 0020): features → sessions → chunks (+ edges within a session).
// Queries go through Drizzle's typed query builder — no hand-written SQL strings. The
// state machines and domain types live in ./model; the tables in ./schema.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  chunks,
  edges,
  features,
  sessions,
  type Chunk,
  type Feature,
  type NewChunk,
  type NewEdge,
  type NewFeature,
  type NewSession,
  type Session,
} from "./schema";
import {
  CHUNK_TRANSITIONS,
  FEATURE_TRANSITIONS,
  SESSION_TRANSITIONS,
  type ChunkOutcome,
  type ChunkState,
  type FeatureState,
  type SessionState,
  type TierHint,
} from "./model";

/** Open a new feature. */
export interface CreateFeature {
  id: string;
  title: string;
  description: string;
}

/** Add a session to a feature (ADR 0020) — its chunk-DAG is added separately. */
export interface CreateSession {
  id: string;
  featureId: string;
  locEstimate?: number;
}

/** Add a chunk to a session, carrying the ADR 0014 spec the chief authored. */
export interface CreateChunk {
  id: string;
  sessionId: string;
  surface: string;
  intent: string;
  contract: string;
  acceptance: string;
  dataShapes?: string;
  preResolved?: string;
  outOfScope?: string;
  tierHint?: TierHint;
}

/** A feature meta-decomposed into its sessions (ADR 0020 §2, pass 1) — the chief's first
 *  decompose pass: the feature + its ~1k-LOC session boundaries, no chunks yet. */
export interface CreateMetaDecomposition {
  feature: CreateFeature;
  sessions: { id: string; locEstimate?: number }[];
}

/** A revision to a planned chunk's spec (ADR 0020 §5b) — only the fields given change. */
export interface ReviseChunk {
  surface?: string;
  intent?: string;
  contract?: string;
  acceptance?: string;
  dataShapes?: string;
  preResolved?: string;
  outOfScope?: string;
  tierHint?: TierHint;
}

/** The session's session-main branch + PR linkage (populated by slice 2). */
export interface SessionLinks {
  branch?: string;
  prNumber?: number;
  prUrl?: string;
}

// The shared substrate db (dispatch + plan are sibling tables in it) and the committed
// migration set, resolved relative to this file so the path holds regardless of cwd.
const DEFAULT_DB_PATH = ".substrate/substrate.db";
const MIGRATIONS_DIR = join(import.meta.dir, "../../../drizzle");

// Row builders — one source of truth for each table's insert shape and defaults, shared by
// the singular inserts and the batch (createDecomposition), so the two paths can't drift.
function featureValues(rec: CreateFeature, now: number): NewFeature {
  return { id: rec.id, title: rec.title, description: rec.description, state: "planning", createdAt: now, updatedAt: now };
}

function sessionValues(rec: CreateSession, now: number): NewSession {
  return {
    id: rec.id,
    featureId: rec.featureId,
    locEstimate: rec.locEstimate ?? null,
    state: "planning",
    createdAt: now,
    updatedAt: now,
  };
}

function chunkValues(rec: CreateChunk, now: number): NewChunk {
  return {
    id: rec.id,
    sessionId: rec.sessionId,
    surface: rec.surface,
    intent: rec.intent,
    contract: rec.contract,
    acceptance: rec.acceptance,
    dataShapes: rec.dataShapes ?? null,
    preResolved: rec.preResolved ?? null,
    outOfScope: rec.outOfScope ?? null,
    tierHint: rec.tierHint ?? "cheap",
    state: "planned",
    createdAt: now,
    updatedAt: now,
  };
}

function edgeValues(sessionId: string, from: string, to: string, now: number): NewEdge {
  return { id: `${from}->${to}`, sessionId, fromChunkId: from, toChunkId: to, createdAt: now };
}

export class PlanRepository {
  private sqlite: Database;
  private db: BunSQLiteDatabase;

  /**
   * Open (or create) the shared db, enable WAL + FK enforcement, and (by default) apply
   * migrations.
   *
   * `opts.migrate: false` skips the migrate-on-construct — for a long-running process that a
   * shared launch (`make up`) co-starts with others against the same db: two processes
   * migrating one SQLite file at once race and one exits 1, so the launch migrates ONCE up
   * front (`make migrate`) and the processes open a migrated db (ADR 0016 refinement). A
   * standalone construct (tests, CLIs, a fresh dev run) keeps the default and self-migrates.
   */
  constructor(dbPath: string = DEFAULT_DB_PATH, opts: { migrate?: boolean } = {}) {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });

    this.sqlite = new Database(dbPath);
    this.sqlite.run("PRAGMA journal_mode = WAL");
    this.sqlite.run("PRAGMA foreign_keys = ON"); // the FKs are real integrity, not decoration
    this.db = drizzle(this.sqlite);
    if (opts.migrate !== false) migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
  }

  // --- features ---

  /** Open a new feature in state 'planning'. */
  createFeature(rec: CreateFeature): void {
    this.db.insert(features).values(featureValues(rec, Date.now())).run();
  }

  /**
   * Write a feature + its sessions in one transaction — the chief's meta-decompose (ADR 0020
   * pass 1), so a feature never half-lands. Sessions start empty (planning); their chunk-DAGs
   * are added per session by `addChunkDag` (pass 2). FK/unique constraints are the backstop.
   */
  createMetaDecomposition(input: CreateMetaDecomposition): void {
    const now = Date.now();
    this.db.transaction((tx) => {
      tx.insert(features).values(featureValues(input.feature, now)).run();
      for (const s of input.sessions)
        tx.insert(sessions).values(sessionValues({ id: s.id, featureId: input.feature.id, locEstimate: s.locEstimate }, now)).run();
    });
  }

  /**
   * Add a session's chunk-DAG in one transaction — the chief's per-session decompose (ADR
   * 0020 pass 2). Planning-amendable: the parent feature must be in `planning`. Assumes a
   * pre-validated DAG (the service runs `validateDag`); FK/unique constraints are the backstop.
   */
  addChunkDag(sessionId: string, newChunks: CreateChunk[], newEdges: { from: string; to: string }[]): void {
    this.db.transaction((tx) => {
      this.requireFeaturePlanning(tx, this.featureIdForSession(tx, sessionId));
      const now = Date.now();
      for (const c of newChunks) tx.insert(chunks).values(chunkValues(c, now)).run();
      for (const e of newEdges) tx.insert(edges).values(edgeValues(sessionId, e.from, e.to, now)).run();
    });
  }

  getFeature(id: string): Feature | null {
    return this.db.select().from(features).where(eq(features.id, id)).get() ?? null;
  }

  /** Move a feature to a new state, validated against the feature graph. */
  transitionFeature(id: string, to: FeatureState): void {
    this.db.transaction((tx) => {
      const row = tx.select({ state: features.state }).from(features).where(eq(features.id, id)).get();
      if (!row) throw new Error(`no feature ${id}`);
      if (!FEATURE_TRANSITIONS[row.state].includes(to))
        throw new Error(`illegal feature transition ${row.state} → ${to} for ${id}`);
      tx.update(features).set({ state: to, updatedAt: Date.now() }).where(eq(features.id, id)).run();
    });
  }

  // --- sessions ---

  /**
   * Add a session to a feature in state 'planning'. Planning-amendable (ADR 0020): the
   * feature must still be in `planning` — a session can't be added after the owner approved.
   */
  createSession(rec: CreateSession): void {
    this.db.transaction((tx) => {
      this.requireFeaturePlanning(tx, rec.featureId);
      tx.insert(sessions).values(sessionValues(rec, Date.now())).run();
    });
  }

  getSession(id: string): Session | null {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get() ?? null;
  }

  /** A feature's sessions, oldest first. */
  listSessions(featureId: string): Session[] {
    return this.db.select().from(sessions).where(eq(sessions.featureId, featureId)).orderBy(asc(sessions.createdAt)).all();
  }

  /** Every session across all features, oldest first — what the session loop sweeps to find
   *  the sessions of approved features it should open + advance (ADR 0020 slice 2b). */
  listAllSessions(): Session[] {
    return this.db.select().from(sessions).orderBy(asc(sessions.createdAt)).all();
  }

  /** Move a session to a new state, validated against the session graph (transactional). */
  transitionSession(id: string, to: SessionState): void {
    this.db.transaction((tx) => {
      const row = tx.select({ state: sessions.state }).from(sessions).where(eq(sessions.id, id)).get();
      if (!row) throw new Error(`no session ${id}`);
      if (!SESSION_TRANSITIONS[row.state].includes(to))
        throw new Error(`illegal session transition ${row.state} → ${to} for ${id}`);
      tx.update(sessions).set({ state: to, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
    });
  }

  /** Link a session to its session-main branch + PR (slice 2 populates these). */
  linkSessionPr(id: string, links: SessionLinks): void {
    const values: Partial<NewSession> = {};
    if (links.branch !== undefined) values.branch = links.branch;
    if (links.prNumber !== undefined) values.prNumber = links.prNumber;
    if (links.prUrl !== undefined) values.prUrl = links.prUrl;
    if (Object.keys(values).length === 0) return;

    const row = this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get();
    if (!row) throw new Error(`no session ${id}`);
    this.db.update(sessions).set({ ...values, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
  }

  // --- chunks ---

  /** Add a chunk to a session in state 'planned'. Planning-amendable: the parent feature
   *  must be in `planning` (ADR 0020). The session FK is enforced. */
  addChunk(rec: CreateChunk): void {
    this.db.transaction((tx) => {
      this.requireFeaturePlanning(tx, this.featureIdForSession(tx, rec.sessionId));
      tx.insert(chunks).values(chunkValues(rec, Date.now())).run();
    });
  }

  getChunk(id: string): Chunk | null {
    return this.db.select().from(chunks).where(eq(chunks.id, id)).get() ?? null;
  }

  /** A session's chunks, oldest first. */
  listChunks(sessionId: string): Chunk[] {
    return this.db.select().from(chunks).where(eq(chunks.sessionId, sessionId)).orderBy(asc(chunks.createdAt)).all();
  }

  /** Every chunk across all sessions — what a global sweep (the terminal reaper) needs to
   *  know which dispatch ids are still the current attempt for some chunk. */
  listAllChunks(): Chunk[] {
    return this.db.select().from(chunks).orderBy(asc(chunks.createdAt)).all();
  }

  /** A session's dependency edges as from→to pairs — what the service needs to validate a
   *  re-decomposition's projected graph (it never reaches into the edges table itself). */
  listEdges(sessionId: string): { from: string; to: string }[] {
    return this.db
      .select({ from: edges.fromChunkId, to: edges.toChunkId })
      .from(edges)
      .where(eq(edges.sessionId, sessionId))
      .all();
  }

  /**
   * A session's chunks ready to dispatch: state 'planned' (not yet dispatched) whose every
   * dependency (incoming edge's `from`) has reached 'done'. Roots (no deps) are ready.
   * This is what the loop pulls from, per session (ADR 0020).
   */
  readyChunks(sessionId: string): Chunk[] {
    const all = this.listChunks(sessionId);
    const done = new Set(all.filter((c) => c.state === "done").map((c) => c.id));
    const deps = this.depsByChunk(sessionId);
    return all.filter(
      (c) => c.state === "planned" && (deps.get(c.id) ?? []).every((from) => done.has(from)),
    );
  }

  /** Move a chunk to a new state, validated against the chunk graph (transactional). */
  transition(id: string, to: ChunkState): void {
    this.moveChunk(id, to, {});
  }

  /** Set a chunk's build tier hint (the chief tier-promotes an escalated chunk to 'strong'
   *  before re-dispatching it, ADR 0019). Throws if the chunk is absent. */
  setTierHint(id: string, tier: TierHint): void {
    const row = this.db.select({ id: chunks.id }).from(chunks).where(eq(chunks.id, id)).get();
    if (!row) throw new Error(`no chunk ${id}`);
    this.db.update(chunks).set({ tierHint: tier, updatedAt: Date.now() }).where(eq(chunks.id, id)).run();
  }

  // --- planning-amendable: revise + prune (ADR 0020 §5b) ---
  // The chief iterates the plan with the owner BEFORE approval. All four are gated on the
  // parent feature being in `planning` (frozen once approved), so a built/approved plan is
  // never edited out from under the loop.

  /** Re-spec a planned chunk (change only the fields given). Planning-amendable. */
  reviseChunk(id: string, spec: ReviseChunk): void {
    this.db.transaction((tx) => {
      const row = tx.select({ sessionId: chunks.sessionId }).from(chunks).where(eq(chunks.id, id)).get();
      if (!row) throw new Error(`no chunk ${id}`);
      this.requireFeaturePlanning(tx, this.featureIdForSession(tx, row.sessionId));

      const values: Partial<NewChunk> = { updatedAt: Date.now() };
      if (spec.surface !== undefined) values.surface = spec.surface;
      if (spec.intent !== undefined) values.intent = spec.intent;
      if (spec.contract !== undefined) values.contract = spec.contract;
      if (spec.acceptance !== undefined) values.acceptance = spec.acceptance;
      if (spec.dataShapes !== undefined) values.dataShapes = spec.dataShapes;
      if (spec.preResolved !== undefined) values.preResolved = spec.preResolved;
      if (spec.outOfScope !== undefined) values.outOfScope = spec.outOfScope;
      if (spec.tierHint !== undefined) values.tierHint = spec.tierHint;
      tx.update(chunks).set(values).where(eq(chunks.id, id)).run();
    });
  }

  /** Remove a planned chunk and every edge touching it. Planning-amendable. */
  removeChunk(id: string): void {
    this.db.transaction((tx) => {
      const row = tx.select({ sessionId: chunks.sessionId }).from(chunks).where(eq(chunks.id, id)).get();
      if (!row) throw new Error(`no chunk ${id}`);
      this.requireFeaturePlanning(tx, this.featureIdForSession(tx, row.sessionId));
      tx.delete(edges).where(or(eq(edges.fromChunkId, id), eq(edges.toChunkId, id))).run();
      tx.delete(chunks).where(eq(chunks.id, id)).run();
    });
  }

  /** Remove a session and its whole sub-plan (its chunks + edges). Planning-amendable. */
  removeSession(id: string): void {
    this.db.transaction((tx) => {
      const row = tx.select({ featureId: sessions.featureId }).from(sessions).where(eq(sessions.id, id)).get();
      if (!row) throw new Error(`no session ${id}`);
      this.requireFeaturePlanning(tx, row.featureId);
      tx.delete(edges).where(eq(edges.sessionId, id)).run();
      tx.delete(chunks).where(eq(chunks.sessionId, id)).run();
      tx.delete(sessions).where(eq(sessions.id, id)).run();
    });
  }

  /** Remove a single dependency edge (`from`→`to`). Planning-amendable. */
  removeEdge(fromChunkId: string, toChunkId: string): void {
    this.db.transaction((tx) => {
      const match = and(eq(edges.fromChunkId, fromChunkId), eq(edges.toChunkId, toChunkId));
      const row = tx.select({ sessionId: edges.sessionId }).from(edges).where(match).get();
      if (!row) throw new Error(`no edge ${fromChunkId}->${toChunkId}`);
      this.requireFeaturePlanning(tx, this.featureIdForSession(tx, row.sessionId));
      tx.delete(edges).where(match).run();
    });
  }

  /**
   * Re-decompose an escalated chunk (ADR 0019): retire it (escalated → superseded), drop
   * every edge touching it within its session (its dependents are reconnected by the new
   * edges the chief supplies), and add the replacement chunks + edges — all in one
   * transaction, so the plan never half-rewires. Assumes a pre-validated graph (the service
   * runs `validateDag` over the projected session graph); FK/unique constraints are the
   * backstop. This is escalation handling (post-approval), not a planning amendment.
   */
  redecompose(escalatedChunkId: string, newChunks: CreateChunk[], newEdges: { from: string; to: string }[]): void {
    this.db.transaction((tx) => {
      const row = tx
        .select({ state: chunks.state, sessionId: chunks.sessionId })
        .from(chunks)
        .where(eq(chunks.id, escalatedChunkId))
        .get();
      if (!row) throw new Error(`no chunk ${escalatedChunkId}`);
      if (!CHUNK_TRANSITIONS[row.state].includes("superseded"))
        throw new Error(`illegal chunk transition ${row.state} → superseded for ${escalatedChunkId}`);

      tx.delete(edges)
        .where(
          and(
            eq(edges.sessionId, row.sessionId),
            or(eq(edges.fromChunkId, escalatedChunkId), eq(edges.toChunkId, escalatedChunkId)),
          ),
        )
        .run();
      tx.update(chunks).set({ state: "superseded", updatedAt: Date.now() }).where(eq(chunks.id, escalatedChunkId)).run();

      const now = Date.now();
      for (const c of newChunks) tx.insert(chunks).values(chunkValues(c, now)).run();
      for (const e of newEdges) tx.insert(edges).values(edgeValues(row.sessionId, e.from, e.to, now)).run();
    });
  }

  /**
   * Link a chunk to the dispatch it was materialized as and move it to 'dispatched',
   * atomically. The dispatch FK is enforced — the row must exist (the service created
   * it from this chunk's spec).
   */
  linkDispatch(chunkId: string, dispatchId: string): void {
    this.moveChunk(chunkId, "dispatched", { dispatchId });
  }

  /**
   * Flow a dispatch's terminal outcome back onto its chunk (ADR 0019). The service reads
   * the outcome from the dispatch registry and hands it here — the plan repo does not
   * reach across contexts.
   */
  recordOutcome(chunkId: string, outcome: ChunkOutcome): void {
    this.moveChunk(chunkId, outcome, {});
  }

  // --- edges ---

  /**
   * Add a dependency edge (`to` depends on `from`) within a session. Rejects a self-edge or
   * one that would create a cycle in the session's DAG. Planning-amendable: the parent
   * feature must be in `planning`. The chunk/session FKs are enforced.
   */
  addEdge(sessionId: string, fromChunkId: string, toChunkId: string): void {
    if (fromChunkId === toChunkId) throw new Error(`addEdge: self-edge on chunk ${fromChunkId}`);
    this.db.transaction((tx) => {
      this.requireFeaturePlanning(tx, this.featureIdForSession(tx, sessionId));
      if (this.reaches(sessionId, toChunkId, fromChunkId))
        throw new Error(`addEdge: ${fromChunkId} → ${toChunkId} would create a cycle`);
      tx.insert(edges).values(edgeValues(sessionId, fromChunkId, toChunkId, Date.now())).run();
    });
  }

  /** Close the underlying db handle. */
  close(): void {
    this.sqlite.close();
  }

  // --- internals ---

  // Resolve a session's feature id (within a tx), or throw if the session is absent.
  private featureIdForSession(tx: BunSQLiteDatabase, sessionId: string): string {
    const row = tx.select({ featureId: sessions.featureId }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) throw new Error(`no session ${sessionId}`);
    return row.featureId;
  }

  // Planning-amendable guard (ADR 0020): structural plan edits (add session/chunk/edge) are
  // allowed only while the feature is in `planning` — frozen once the owner approves.
  private requireFeaturePlanning(tx: BunSQLiteDatabase, featureId: string): void {
    const row = tx.select({ state: features.state }).from(features).where(eq(features.id, featureId)).get();
    if (!row) throw new Error(`no feature ${featureId}`);
    if (row.state !== "planning")
      throw new Error(`feature ${featureId} is not amendable (state: ${row.state}) — approved plans are frozen`);
  }

  // Validate a chunk state move against the graph inside a transaction, then apply the
  // move plus any extra column writes (the dispatch link). One place owns the checks.
  private moveChunk(id: string, to: ChunkState, extra: { dispatchId?: string }): void {
    this.db.transaction((tx) => {
      const row = tx.select({ state: chunks.state }).from(chunks).where(eq(chunks.id, id)).get();
      if (!row) throw new Error(`no chunk ${id}`);
      if (!CHUNK_TRANSITIONS[row.state].includes(to))
        throw new Error(`illegal chunk transition ${row.state} → ${to} for ${id}`);
      tx.update(chunks)
        .set({ ...extra, state: to, updatedAt: Date.now() })
        .where(eq(chunks.id, id))
        .run();
    });
  }

  // dependency adjacency for a session: chunk id → the ids it depends on (incoming `from`s).
  private depsByChunk(sessionId: string): Map<string, string[]> {
    const rows = this.db
      .select({ from: edges.fromChunkId, to: edges.toChunkId })
      .from(edges)
      .where(eq(edges.sessionId, sessionId))
      .all();
    const deps = new Map<string, string[]>();
    for (const e of rows) deps.set(e.to, [...(deps.get(e.to) ?? []), e.from]);
    return deps;
  }

  // Can `target` be reached from `start` following from→to edges within a session? Used to
  // detect that a new edge from→to would close a cycle (i.e. `to` already reaches `from`).
  private reaches(sessionId: string, start: string, target: string): boolean {
    const rows = this.db
      .select({ from: edges.fromChunkId, to: edges.toChunkId })
      .from(edges)
      .where(eq(edges.sessionId, sessionId))
      .all();
    const succ = new Map<string, string[]>();
    for (const e of rows) succ.set(e.from, [...(succ.get(e.from) ?? []), e.to]);

    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (node === target) return true;
      for (const next of succ.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  }
}
