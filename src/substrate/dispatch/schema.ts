// The dispatch table — the schema source of truth (Drizzle, ADR 0016).
//
// drizzle-kit generates migrations from this file (`bun run db:generate`); the
// repository applies them at startup. Column names are snake_case in SQLite while the
// TS keys are camelCase, so Drizzle's inferred row type IS the camelCase Dispatch
// model directly — no hand-written boundary mapper (the spike cast raw rows; the
// typed-boundary problem is dissolved by the ORM, not papered over).

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { BUILD_TIERS, DISPATCH_STATES, ESCALATIONS } from "./model";

export const dispatches = sqliteTable("dispatches", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull(),
  title: text("title").notNull(),
  branch: text("branch").notNull(),
  // The build spec — the issue body the builder works from. The substrate owns the
  // chunk spec (it survives a restart, so resumeIncomplete can re-build), since a
  // planner-generated chunk isn't always backed by a tracker issue (ADR 0009/0010).
  // NOT NULL: a dispatch with no spec has nothing to build — the domain forbids it
  // (CreateDispatch.spec is required), and the column enforces the same.
  spec: text("spec").notNull(),
  // The chunk's build-context curation, carried so the daemon reconstructs the build
  // Issue from the row and the right context pack injects (ADR 0018/0019). `surface` is
  // the chunk's one file (drives default skill inference); `skills` is the chief's
  // curated skill *names* (not the text — the build leg reads docs/skills/<name>.md at
  // build time). Both nullable: a dispatch with neither falls back to standards-only.
  // Persisted (not just in-memory) so a resumed build (resumeIncomplete) keeps curation.
  surface: text("surface"),
  skills: text("skills", { mode: "json" }).$type<string[]>(),
  // The build tier (ADR 0013/0014), carried from the chunk's tierHint so the daemon
  // builds on the cheap or strong builder agent — and survives a resumed build. Null is
  // treated as cheap (the default route); a tier-promoted re-dispatch carries 'strong'.
  tier: text("tier", { enum: BUILD_TIERS }),
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
