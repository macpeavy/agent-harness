// The dispatch table — the schema source of truth (Drizzle, ADR 0016).
//
// drizzle-kit generates migrations from this file (`bun run db:generate`); the
// repository applies them at startup. Column names are snake_case in SQLite while the
// TS keys are camelCase, so Drizzle's inferred row type IS the camelCase Dispatch
// model directly — no hand-written boundary mapper (the spike cast raw rows; the
// typed-boundary problem is dissolved by the ORM, not papered over).

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DISPATCH_STATES, ESCALATIONS } from "./model";

export const dispatches = sqliteTable("dispatches", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull(),
  title: text("title").notNull(),
  branch: text("branch").notNull(),
  state: text("state", { enum: DISPATCH_STATES }).notNull().default("queued"),
  // Linked OpenCode session ids — the registry links them, it does not own the
  // sessions or duplicate their data (ADR 0009, above-OpenCode layering).
  buildSessionId: text("build_session_id"),
  reviewSessionId: text("review_session_id"),
  prUrl: text("pr_url"),
  // The cheap-able-fraction instrument: route, amend rounds, escalation, per-leg cost.
  route: text("route"),
  amendRounds: integer("amend_rounds").notNull().default(0),
  escalated: text("escalated", { enum: ESCALATIONS }),
  buildCostUsd: real("build_cost_usd"),
  reviewCostUsd: real("review_cost_usd"),
  amendCostUsd: real("amend_cost_usd"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** A persisted dispatch row, camelCase, inferred from the schema. */
export type Dispatch = InferSelectModel<typeof dispatches>;
/** The shape accepted by an insert, inferred from the schema. */
export type NewDispatch = InferInsertModel<typeof dispatches>;
