---
name: persistence-drizzle
description: Use when adding persistent state to the substrate (the dispatch registry, any on-disk store). The Drizzle-over-bun:sqlite pattern — schema as code, generated migrations, a typed query builder (no SQL strings), transactions around every multi-statement mutation. Pairs ADR 0009 (the registry contract) + ADR 0016 (the mechanism).
---

# Persistence with Drizzle (over bun:sqlite)

**When:** you're adding durable state — the dispatch registry, a planner table, any store
the substrate must survive a restart with. Pairs **ADR 0009** (the registry sits *above*
OpenCode's session store: it links session ids, it does not duplicate session/message
data) and **ADR 0016** (Drizzle is the data layer; no hand-written SQL).

**Files** (a context owns its layers in one directory under `substrate/`): the schema
(`substrate/dispatch/schema.ts` — persistence), the domain contract + state machine
(`substrate/dispatch/model.ts` — engine), the repository (`substrate/dispatch/repository.ts`
— the only layer that touches the db), its co-located test, an `index.ts` public surface,
and the generated migrations (`drizzle/`, committed). The db file lives under `.substrate/`
(gitignored, inside the sandbox volume). See `docs/standards.md` § Module organization for
the engine/repository/service/router layering.

## How

1. **Schema as code is the source of truth.** Define the table in `schema.ts` with
   `sqliteTable`, camelCase TS keys mapped to snake_case columns. Type enum columns with
   `text("state", { enum: STATES })` so the union flows into the inferred type. Export
   `type Row = InferSelectModel<typeof table>` — that inferred type *is* your domain model,
   so there is **no row→object mapper and no `as` cast** (the typed-boundary problem is
   dissolved, not papered).
2. **Generate migrations, don't hand-write DDL.** `drizzle.config.ts` points at the schema;
   `bun run db:generate` (drizzle-kit) emits SQL into `drizzle/`. Commit it — migrations are
   source. The store applies them at startup: `migrate(db, { migrationsFolder })` in the
   constructor (gated on an `opts.migrate` default-true), so a fresh db self-initializes.
   **But** a long-running process that shares a db with another (the daemon + the
   session-loop both open the dispatch db) must construct with **`migrate: false`** — two
   processes migrating one SQLite file at once race and one crashes. The launch migrates
   once up front (`make migrate`); those processes open the migrated db (ADR 0021).
3. **Query through the builder — no SQL strings.** `db.select().from(t).where(eq(t.id, id))`,
   `db.insert(t).values(...)`, `db.update(t).set(...).where(...)`. The only allowed `sql`
   fragments are for things SQLite exposes but the schema doesn't model — an in-place
   increment (`sql\`COALESCE(${t.cost}, 0) + ${n}\``) or a `rowid` ordering tiebreak — and
   even there the values are **bound**, never interpolated.
4. **Wrap read-validate-write and multi-field writes in a transaction** (`db.transaction`).
   A state transition that reads the current state, validates it against the graph, and
   writes state + `updated_at` is one atomic unit — do it inside `transaction((tx) => …)`
   so a concurrent writer can't slip between the read and the write. (The spike's raw-SQL
   registry shipped an atomicity bug by firing two un-transactioned updates.)
5. **Validate transitions against the allowed graph and throw on an illegal one.** Keep the
   graph in `dispatch.ts`; **derive** the terminal/non-terminal sets from it (a state with
   no outgoing edges is terminal) — never hardcode a state list (the spike's other finding).
6. **Record the instrument fields** (route, amend rounds, escalation, per-leg cost) — the
   registry is also the cheap-able-fraction measurement (ADR 0009).
7. **WAL + path.** Set `PRAGMA journal_mode = WAL` on the underlying `bun:sqlite` handle
   (concurrent status reads while the loop writes); default the db path under `.substrate/`.

## Worked example (shape)

```ts
// schema.ts — the source of truth (persistence layer)
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { STATES } from "./model";

export const dispatches = sqliteTable("dispatches", {
  id: text("id").primaryKey(),
  state: text("state", { enum: STATES }).notNull().default("queued"),
  updatedAt: integer("updated_at").notNull(),
  // …instrument columns…
});
export type Dispatch = InferSelectModel<typeof dispatches>; // the domain model, camelCase

// repository.ts — the data-access layer: typed query builder + migrate at startup
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { dispatches } from "./schema";
import { TRANSITIONS } from "./model";

const sqlite = new Database(path);
sqlite.run("PRAGMA journal_mode = WAL");
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: "drizzle" });

function transition(id: string, to: string): void {
  db.transaction((tx) => {
    const row = tx.select({ state: dispatches.state })
      .from(dispatches).where(eq(dispatches.id, id)).get();
    if (!row) throw new Error(`no dispatch ${id}`);
    if (!TRANSITIONS[row.state].includes(to))
      throw new Error(`transition: illegal ${row.state} → ${to} for ${id}`);
    tx.update(dispatches).set({ state: to, updatedAt: Date.now() })
      .where(eq(dispatches.id, id)).run();
  });
}
```
