// The plan repository (the data-access layer, ADR 0019) — the only code that touches
// the plan tables, over Drizzle on the shared substrate db (ADR 0016/0017). Plan-only:
// it does NOT depend on the dispatch repository. Binding the two contexts (filling a
// dispatch's spec from a chunk, reading a dispatch outcome) is the service layer's job;
// here `linkDispatch`/`recordOutcome` take what the service hands them.
//
// Queries go through Drizzle's typed query builder — no hand-written SQL strings. The
// state machines and domain types live in ./model; the tables in ./schema.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { chunks, edges, features, type Chunk, type Feature } from "./schema";
import {
  CHUNK_TRANSITIONS,
  FEATURE_TRANSITIONS,
  type ChunkOutcome,
  type ChunkState,
  type FeatureState,
  type TierHint,
} from "./model";

/** Open a new feature. */
export interface CreateFeature {
  id: string;
  title: string;
  description: string;
}

/** Add a chunk to a feature, carrying the ADR 0014 spec the chief authored. */
export interface CreateChunk {
  id: string;
  featureId: string;
  surface: string;
  intent: string;
  contract: string;
  acceptance: string;
  dataShapes?: string;
  preResolved?: string;
  outOfScope?: string;
  tierHint?: TierHint;
}

// The shared substrate db (dispatch + plan are sibling tables in it) and the committed
// migration set, resolved relative to this file so the path holds regardless of cwd.
const DEFAULT_DB_PATH = ".substrate/substrate.db";
const MIGRATIONS_DIR = join(import.meta.dir, "../../../drizzle");

export class PlanRepository {
  private sqlite: Database;
  private db: BunSQLiteDatabase;

  /** Open (or create) the shared db, enable WAL + FK enforcement, apply migrations. */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });

    this.sqlite = new Database(dbPath);
    this.sqlite.run("PRAGMA journal_mode = WAL");
    this.sqlite.run("PRAGMA foreign_keys = ON"); // the FKs are real integrity, not decoration
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
  }

  // --- features ---

  /** Open a new feature in state 'planning'. */
  createFeature(rec: CreateFeature): void {
    const now = Date.now();
    this.db
      .insert(features)
      .values({ id: rec.id, title: rec.title, description: rec.description, state: "planning", createdAt: now, updatedAt: now })
      .run();
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

  // --- chunks ---

  /** Add a chunk to a feature in state 'planned'. The feature FK is enforced. */
  addChunk(rec: CreateChunk): void {
    const now = Date.now();
    this.db
      .insert(chunks)
      .values({
        id: rec.id,
        featureId: rec.featureId,
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
      })
      .run();
  }

  getChunk(id: string): Chunk | null {
    return this.db.select().from(chunks).where(eq(chunks.id, id)).get() ?? null;
  }

  /** All chunks in a feature, oldest first. */
  listChunks(featureId: string): Chunk[] {
    return this.db.select().from(chunks).where(eq(chunks.featureId, featureId)).orderBy(asc(chunks.createdAt)).all();
  }

  /**
   * Chunks ready to dispatch: state 'planned' (not yet dispatched) whose every
   * dependency (incoming edge's `from`) has reached 'done'. Roots (no deps) are ready.
   * This is what the loop pulls from.
   */
  readyChunks(featureId: string): Chunk[] {
    const all = this.listChunks(featureId);
    const done = new Set(all.filter((c) => c.state === "done").map((c) => c.id));
    const deps = this.depsByChunk(featureId);
    return all.filter(
      (c) => c.state === "planned" && (deps.get(c.id) ?? []).every((from) => done.has(from)),
    );
  }

  /** Move a chunk to a new state, validated against the chunk graph (transactional). */
  transition(id: string, to: ChunkState): void {
    this.moveChunk(id, to, {});
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
   * Add a dependency edge (`to` depends on `from`). Rejects a self-edge or one that
   * would create a cycle in the feature's DAG. The chunk/feature FKs are enforced.
   */
  addEdge(featureId: string, fromChunkId: string, toChunkId: string): void {
    if (fromChunkId === toChunkId) throw new Error(`addEdge: self-edge on chunk ${fromChunkId}`);
    if (this.reaches(featureId, toChunkId, fromChunkId))
      throw new Error(`addEdge: ${fromChunkId} → ${toChunkId} would create a cycle`);
    this.db
      .insert(edges)
      .values({
        id: `${fromChunkId}->${toChunkId}`,
        featureId,
        fromChunkId,
        toChunkId,
        createdAt: Date.now(),
      })
      .run();
  }

  /** Close the underlying db handle. */
  close(): void {
    this.sqlite.close();
  }

  // --- internals ---

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

  // dependency adjacency for a feature: chunk id → the ids it depends on (incoming `from`s).
  private depsByChunk(featureId: string): Map<string, string[]> {
    const rows = this.db
      .select({ from: edges.fromChunkId, to: edges.toChunkId })
      .from(edges)
      .where(eq(edges.featureId, featureId))
      .all();
    const deps = new Map<string, string[]>();
    for (const e of rows) deps.set(e.to, [...(deps.get(e.to) ?? []), e.from]);
    return deps;
  }

  // Can `target` be reached from `start` following from→to edges? Used to detect that a
  // new edge from→to would close a cycle (i.e. `to` already reaches `from`).
  private reaches(featureId: string, start: string, target: string): boolean {
    const rows = this.db
      .select({ from: edges.fromChunkId, to: edges.toChunkId })
      .from(edges)
      .where(eq(edges.featureId, featureId))
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
