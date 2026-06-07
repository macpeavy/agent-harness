# Chunk SHAKE-3 — the `harness status` renderer

**Tier:** cheap (default). **Surface:** one new file `src/substrate/dispatch/status.ts` + its co-located test `src/substrate/dispatch/status.test.ts`.

## Intent

Render the dispatch registry as a compact, aligned terminal table — live observability over what the loop is doing — plus a runnable entrypoint (`bun run src/substrate/dispatch/status.ts`).

## Context pack — read these first

- `docs/standards.md` — the coding standard (typed boundaries, explicit return types, top-of-file comment, `bun:test`, the `import.meta.main` runnable convention).
- `.claude/skills/writing-tests.md` — the test convention.
- `.claude/skills/adding-a-substrate-module.md` — the module shape (top comment with lineage + a `Run:` line; the pure-core-plus-thin-runnable pattern).
- `src/substrate/dispatch/model.ts` / `schema.ts` — the `Dispatch` type. Relevant fields: `id`, `state`, `route` (nullable), `amendRounds`, and the nullable per-leg costs `buildCostUsd`/`reviewCostUsd`/`amendCostUsd`.
- `src/substrate/dispatch/repository.ts` and `index.ts` — `DispatchRepository` with `list()` (returns `Dispatch[]`, newest first) and how it's constructed (`new DispatchRepository()` uses the default db path).

Do not read beyond these.

## Contract (exact — must produce)

```ts
/** Render dispatches as an aligned plain-text table. Pure — renders the rows given, in
 *  the order given. */
export function renderStatus(dispatches: Dispatch[]): string;
```

Plus an `import.meta.main` block: open `new DispatchRepository()`, call `list()`, print `renderStatus(...)` to stdout, then `close()` the repository.

## Pre-resolved design decisions (do NOT deviate)

- **Columns, in this order:** `ID`, `STATE`, `ROUTE`, `AMENDS`, `COST`. No other columns.
  - `ID` ← `id`, `STATE` ← `state`, `ROUTE` ← `route` (null → `"—"`), `AMENDS` ← `amendRounds`, `COST` ← the **sum** of the three leg costs (each null → 0), formatted as `"$" + total.toFixed(4)`.
- **Alignment:** a header row, then one row per dispatch. Each column is padded to the width of the widest cell in that column (including the header). Text columns (`ID`, `STATE`, `ROUTE`) left-aligned; numeric columns (`AMENDS`, `COST`) right-aligned. Columns separated by two spaces. No outer borders, no separator line under the header.
- **Empty input** → return the single line `"No dispatches."` (not an empty table, not a throw).
- **Order:** render in the order passed in (the caller/`list()` already sorts newest-first; `renderStatus` does not re-sort).
- **Cost formatting is inline** here (`"$" + n.toFixed(4)`). Do **not** depend on `src/util/format.ts` — it is a sibling chunk and may not exist on this branch. (Adopting it later is a follow-up, out of scope.)
- The file's top comment names what it is + a `Run:` line. The `import.meta.main` block is the only place that touches the database; keep it thin.

## Acceptance

`bun run typecheck` and `bun test` both green, with `status.test.ts` covering `renderStatus` (the pure function — do **not** test `import.meta.main`, which hits the real db):
- a couple of dispatches → output contains the header, each id and state, the route fallback `"—"` for a null route, and a summed `$`-cost; columns are aligned (assert a specific expected line or the padded widths).
- empty input → exactly `"No dispatches."`.
- a dispatch with all-null costs → `COST` is `"$0.0000"`.

Build `Dispatch` test fixtures as plain objects of the right shape (you may cast a literal to `Dispatch`); you do not need the database in the test.

## Out of scope

ANSI color, watch/auto-refresh, filtering/paging, adopting `format.ts`, unit-testing the `import.meta.main` runnable, any change to the repository.
