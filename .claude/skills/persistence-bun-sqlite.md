---
name: persistence-bun-sqlite
description: Use when adding persistent state to the substrate (the dispatch registry, any on-disk store). The bun:sqlite pattern — prepared statements, transactions, a validated state machine — paired with ADR 0009.
---

# Persistence with bun:sqlite

**When:** you're adding durable state — the dispatch registry, or any store the
substrate must survive a restart with. Pairs with **ADR 0009** (the registry sits
*above* OpenCode's session store: it links session ids, it does not duplicate
session/message data).

**Files:** the store module under `src/substrate/` (e.g. `registry.ts`) + its co-located
test. The db file lives under `.substrate/` (the substrate's runtime-state dir, gitignored,
inside the sandbox volume).

## How

1. **Use `bun:sqlite` — no external deps, no server, no ORM.** `import { Database }
   from "bun:sqlite"`.
2. **Create the schema if absent** in the constructor; open the db from a path arg
   (default under `.substrate/`). Enable WAL mode for concurrent reads (a status
   surface reads while the loop writes).
3. **Prepared statements** for every query (`db.query(...)`), reused — not string-built SQL.
4. **Wrap any multi-statement mutation in a transaction** (`db.transaction(...)`). A
   state transition that writes state *and* `updated_at` is one atomic unit — the
   spike's registry shipped an atomicity bug here; it's a requirement, not a nicety.
5. **Validate state transitions against the allowed graph and throw on an illegal one.**
   Derive the terminal/non-terminal sets from the graph; never hardcode a state list
   (the spike's other finding).
6. **Record the instrument fields** (route, amend rounds, escalation, cost) — the
   registry is also the cheap-able-fraction measurement (ADR 0009).

## Worked example (shape)

```ts
import { Database } from "bun:sqlite";

const TRANSITIONS: Record<string, string[]> = {
  queued: ["building"], building: ["review", "failed"],
  review: ["amending", "done", "failed"], amending: ["review", "escalated", "failed"],
};

export class DispatchRegistry {
  private db: Database;
  constructor(path = ".substrate/dispatches.db") {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS dispatches (...)`);
  }

  transition(id: string, to: string): void {
    const row = this.get(id);
    if (!row) throw new Error(`transition: no dispatch ${id}`);
    if (!TRANSITIONS[row.state]?.includes(to))
      throw new Error(`transition: illegal ${row.state} → ${to} for ${id}`);
    this.db.transaction(() => {
      this.db.query("UPDATE dispatches SET state=?, updated_at=? WHERE id=?")
        .run(to, Date.now(), id);
    })();
  }
}
```
