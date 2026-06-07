// The plan tables — the schema source of truth (Drizzle, ADR 0016/0019). Features, the
// chunk-DAG (chunks + dependency edges), in the shared substrate db so every link is a
// real FK: chunks → features, edges → chunks, and the cross-context chunk → dispatches.
// drizzle-kit generates migrations from this file; the repository applies them.

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { dispatches } from "../dispatch/schema";
import { CHUNK_STATES, FEATURE_STATES, TIER_HINTS } from "./model";

/** A feature — the owner's intent, decomposed into a chunk-DAG by the chief. */
export const features = sqliteTable("features", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  state: text("state", { enum: FEATURE_STATES }).notNull().default("planning"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A chunk — one file of work, carrying the spec the chief authors (ADR 0014). */
export const chunks = sqliteTable("chunks", {
  id: text("id").primaryKey(),
  featureId: text("feature_id")
    .notNull()
    .references(() => features.id),
  // The ADR 0014 spec the chief resolves; the dispatch's build-spec is filled from these.
  surface: text("surface").notNull(), // the one file
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

/** A dependency edge — `to` depends on `from` (`from` is the precursor, built first). */
export const edges = sqliteTable(
  "edges",
  {
    id: text("id").primaryKey(),
    featureId: text("feature_id")
      .notNull()
      .references(() => features.id),
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
export type Chunk = InferSelectModel<typeof chunks>;
export type NewChunk = InferInsertModel<typeof chunks>;
export type Edge = InferSelectModel<typeof edges>;
export type NewEdge = InferInsertModel<typeof edges>;
