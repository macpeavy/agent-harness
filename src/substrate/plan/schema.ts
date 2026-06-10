// The plan tables — the schema source of truth (Drizzle, ADR 0016/0019/0020). Two-level:
// features → sessions → chunks (+ dependency edges within a session). In the shared substrate
// db so every link is a real FK: sessions → features, chunks → sessions, edges → chunks, and
// the cross-context chunk → dispatches. drizzle-kit generates migrations from this file.

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { dispatches } from "../dispatch/schema";
import { CHUNK_STATES, FEATURE_STATES, SESSION_STATES, TIER_HINTS } from "./model";

/** A feature — the owner's intent, meta-decomposed into sessions by the chief (ADR 0020). */
export const features = sqliteTable("features", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  state: text("state", { enum: FEATURE_STATES }).notNull().default("planning"),
  // The cost budget for this feature (ADR 0026 decision 2) — estimate × headroom, set when the
  // owner approves. The runtime guard parks the feature's building sessions when the real running
  // total (chief + legs) crosses this. Null = no budget (the guard is opt-in; the feature runs as
  // before). Raised by the owner to resume a budget-parked feature.
  budgetUsd: real("budget_usd"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * A session — a ~1k-LOC unit of a feature (ADR 0020), the reviewable unit: it owns a
 * session-main branch and one PR (both populated later by slice 2 — null until then) and
 * holds a chunk-DAG. The tier between feature and chunks.
 */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  featureId: text("feature_id")
    .notNull()
    .references(() => features.id),
  // The session-main branch + the single session PR (session-main → main). Populated by the
  // build leg (slice 2); null until then.
  branch: text("branch"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  // The chief's ~1k-LOC target used to draw the session boundary (ADR 0020) — advisory.
  locEstimate: integer("loc_estimate"),
  state: text("state", { enum: SESSION_STATES }).notNull().default("planning"),
  // The most recent session-loop tick error (ADR 0020 robustness) — set when advance() throws,
  // cleared on the next clean tick. The loop catches + continues (one session's throw must
  // never exit the process); this is how the error surfaces in `status` for the chief.
  lastError: text("last_error"),
  // The budget-park marker (ADR 0026 decision 2): the real running total observed when this
  // session parked for crossing its feature's budget. Null = not budget-parked. Distinguishes a
  // budget park (feature-level, between chunks) from a chunk-failure park (a parked dispatch), and
  // prevents the recordOutcomes auto-resume from un-parking it before the owner raises the budget.
  budgetExceededUsd: real("budget_exceeded_usd"),
  // The notify pass's exactly-once key (ADR 0024): when this session's current signalling
  // state was signaled (chief woken / owner notified). Null = not yet signaled — the pass
  // selects on it, fires once, stamps. Every state transition clears it, so entering a
  // signalling state re-arms the signal (a re-park re-signals) and the transition and the
  // notify stay decoupled (crash-safe: the loop can die between them without double-firing
  // or dropping).
  signaledAt: integer("signaled_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A chunk — one coherent change, carrying the spec the chief authors (ADR 0014). Belongs
 *  to a session (ADR 0020), not directly to a feature. */
export const chunks = sqliteTable("chunks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id),
  surface: text("surface").notNull(), // the file(s) this chunk changes
  intent: text("intent").notNull(), // one sentence
  contract: text("contract").notNull(), // signatures / types / exports — load-bearing
  acceptance: text("acceptance").notNull(), // criteria incl. a test file
  dataShapes: text("data_shapes"),
  preResolved: text("pre_resolved"), // the would-be amends, decided up front
  outOfScope: text("out_of_scope"),
  tierHint: text("tier_hint", { enum: TIER_HINTS }).notNull().default("cheap"),
  state: text("state", { enum: CHUNK_STATES }).notNull().default("planned"),
  // The dispatch this chunk was materialized as (the registry row) — a real cross-context
  // FK. Null until the service dispatches it; the service binds the two repositories.
  dispatchId: text("dispatch_id").references(() => dispatches.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A dependency edge — `to` depends on `from` (`from` is the precursor). Within one session
 *  (the DAG is session-scoped, ADR 0020). */
export const edges = sqliteTable(
  "edges",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    fromChunkId: text("from_chunk_id")
      .notNull()
      .references(() => chunks.id),
    toChunkId: text("to_chunk_id")
      .notNull()
      .references(() => chunks.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("edges_from_to_unq").on(t.fromChunkId, t.toChunkId)],
);

export type Feature = InferSelectModel<typeof features>;
export type NewFeature = InferInsertModel<typeof features>;
export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;
export type Chunk = InferSelectModel<typeof chunks>;
export type NewChunk = InferInsertModel<typeof chunks>;
export type Edge = InferSelectModel<typeof edges>;
export type NewEdge = InferInsertModel<typeof edges>;
