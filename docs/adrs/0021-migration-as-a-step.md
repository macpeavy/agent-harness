# 0021 — Migration is a deliberate step, not per-process startup

- **Status:** proposed
- **Date:** 2026-06-08
- **Refines:** 0016 (the migrate-on-construct mechanism), under multiple processes.

## Context

ADR 0016 had each repository run `migrate()` in its constructor, so a db self-initializes on open. That is clean for **one** process. The session-main redesign (ADR 0020) added a second long-running process — the **session-loop** — alongside the **daemon**, and both open the same dispatch SQLite db. `make up` launches them together, so two processes ran `migrate()` on one db file at the same instant → a migration race → the session-loop lost the lock and exited 1. This was the first live `make up` crash; the daemon (which won the race) looked fine, masking the cause.

## Decision

When multiple processes share a db, **migration is a single deliberate step, not per-process startup.**

- A **`make migrate`** target applies the substrate migrations once; **`make up` depends on it** and runs it before launching any pane.
- The repository constructor takes **`opts.migrate`** (default `true`). The long-running, db-sharing processes (the daemon, the session-loop) construct with **`migrate: false`** and open an already-migrated db.
- **Migrate-on-construct stays the default** for single-process and standalone use — tests, CLIs, a fresh dev run self-migrate, so 0016's "a fresh db self-initializes" ergonomics hold where there's no concurrent migrator.

## Consequences

- No concurrent-migrate race: exactly one migrator runs, up front. The daemon + session-loop open a migrated db.
- Migration is explicit at launch (`make migrate`), and visible as a step rather than a hidden constructor side effect.
- Single-process ergonomics are preserved (the `migrate: false` is opt-in for the shared-db long-runners only).
- The `persistence-drizzle` skill is updated to teach the `migrate: false` option for any long-running process that shares a db with another.

## Alternatives considered

- **Concurrency-safe migrate (busy_timeout + retry).** Rejected — concurrent *schema* migration is racy even with a busy timeout (two runners can both attempt the same migration, risking a partial/duplicate apply). Single-migrator ownership is simpler and correct.
- **Keep migrate-on-construct everywhere.** Rejected — that is the bug.
- **A separate migrations service/daemon.** Over-weight for a single-box embedded SQLite store; a one-shot `make migrate` step is the right size.

## Open questions

- Whether CI (when it exists) runs `make migrate` + a drift check before tests.
