# 0016 — Persistence via Drizzle ORM, not hand-written SQL

- **Status:** proposed
- **Date:** 2026-06-07
- **Supersedes:** 0009 on the persistence *mechanism* only. Everything else in 0009 — the above-OpenCode layering (link session ids, never duplicate session/message data), the dispatch state machine, crash recovery via `resumeIncomplete()`, and the cheap-able-fraction instrument columns — stands unchanged. This ADR replaces only "bun:sqlite raw, no ORM, no deps" with "Drizzle over bun:sqlite."

## Context

ADR 0009 specified the dispatch registry on **raw `bun:sqlite`, no ORM, no deps**, and the `persistence-bun-sqlite` skill taught hand-written SQL (`db.query("…SQL…")`) with prepared statements and manual transactions. AGENT-18 built the registry that way (PR #41, first cut). In review the owner called out two things: SQL strings scattered through the data layer (a standing dislike), and a typed-boundary smell — the row cast (`stmt.get() as DispatchRecord`) is exactly the untyped-foreign-JSON pattern `docs/standards.md` forbids, just pointed at SQLite instead of an HTTP body.

The "no deps" stance was a spike-era reflex (keep the substrate near-dependency-free) rather than a load-bearing constraint. Weighed against a real, recurring data layer — the registry now, the planner's sibling tables next (ADR 0010), schema that versions as the lifecycle grows (0009's own open question) — a typed data layer earns its single dependency.

## Decision

Adopt **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) as the substrate's persistence layer, over the `bun:sqlite` driver.

- **Schema as code is the source of truth.** Tables are defined in TypeScript (`src/substrate/dispatch/schema.ts`); `drizzle-kit generate` (`bun run db:generate`) emits SQL migrations into `drizzle/` (committed — migrations are source). The repository applies pending migrations at startup (`migrate()` in the constructor), so a fresh db self-initializes and a restart picks up new migrations. This answers 0009's flagged schema-versioning open question.
- **No hand-written SQL strings.** Reads and writes go through Drizzle's typed query builder. The narrow, justified exceptions are `sql` template fragments for things SQLite exposes but the schema does not model — an in-place increment (`COALESCE(col,0) + $n`) or a `rowid` ordering tiebreak — where the values are still bound, not interpolated. These are Drizzle idioms, not the raw-query anti-pattern.
- **The typed boundary is dissolved, not papered.** Column names are snake_case in SQLite while the TS keys are camelCase, so Drizzle's inferred `InferSelectModel` row type *is* the camelCase domain model directly. No hand-written row→model mapper, no `as` cast (the spike's smell).
- **Transactions stay first-class.** `db.transaction(...)` wraps every read-validate-write (the state-transition guard) and every multi-field write, so 0009's atomicity requirement holds — now enforced by the ORM's transaction API rather than hand-rolled.
- **Still one process, still WAL.** Drizzle is a compile-time query builder over the same single-writer `bun:sqlite`; WAL mode is set on the underlying handle for concurrent reads (ADR 0006's thin status read). No server, no second runtime.

## Consequences

- The data layer reads as typed TypeScript, not SQL-in-strings; query mistakes surface at compile time against the schema.
- The substrate takes its first real runtime dependency (`drizzle-orm`) plus a dev dependency (`drizzle-kit`). The "near-dependency-free" posture in `docs/standards.md` § Language & runtime is relaxed to a **carve-out**: prefer Bun built-ins by default; Drizzle is the sanctioned data-layer dependency.
- Migrations are now a committed artifact and a build step. Schema changes flow through `bun run db:generate`, reviewed as SQL in the PR.
- The `persistence-bun-sqlite` skill is replaced by `persistence-drizzle`; ADR 0009's mechanism text is superseded here (its design requirements are not).
- Personas/legs that consume the registry (the loop daemon AGENT-19, the amend leg AGENT-20) import the typed model and the state machine, not SQL.

## Alternatives considered

- **Keep raw `bun:sqlite`, centralize SQL into named prepared statements.** The zero-dependency option. Rejected: it organizes the SQL but does not remove it, and leaves the typed-boundary cast in place — it addresses the symptom (scatter), not the substance (untyped strings the owner wants gone).
- **Kysely (typed query builder, not an ORM).** Closest to the thin-substrate ethos, and it also kills SQL strings. Rejected in favor of Drizzle for two concrete reasons: Drizzle ships a **first-party `bun:sqlite` driver** (Kysely's is a community dialect), and `drizzle-kit` gives generated migrations out of the box — the schema-versioning need 0009 already flagged. Kysely would have meant hand-managed migrations and a less Bun-native driver.
- **A full server-backed ORM / Prisma.** Rejected: Prisma's separate schema DSL, codegen client, and query-engine binary are far heavier than this single-process embedded store needs; Drizzle's schema-as-code in plain TS is the right weight.

## Open questions

- Migration discipline as multiple tables land (the planner's sibling tables, ADR 0010): one migrations folder for the whole substrate vs. per-domain — likely one, decided with 0010's implementation.
- Whether a `bun run db:check` / drift-check step belongs in CI once CI exists.
