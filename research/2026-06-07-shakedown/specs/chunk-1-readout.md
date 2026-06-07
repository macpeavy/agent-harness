# Chunk SHAKE-1 — the cheap-able-fraction readout

**Tier:** cheap (default). **Surface:** one new file `src/substrate/dispatch/readout.ts` + its co-located test `src/substrate/dispatch/readout.test.ts`.

## Intent

Compute the cheap-able-fraction readout — the cost-and-quality metrics ADR 0009 built the registry instrument to feed — as a pure function over dispatch rows.

## Context pack — read these first

- `docs/standards.md` — the coding standard every change follows (typed boundaries, explicit return types, error handling, `bun:test`).
- `.claude/skills/writing-tests.md` — the test convention (co-located, one behavior per `it`, assert real values).
- `src/substrate/dispatch/model.ts` and `src/substrate/dispatch/schema.ts` — the `Dispatch` type you operate on (import it) and its `DispatchState` union. Note the per-leg cost fields are **nullable**: `buildCostUsd`, `reviewCostUsd`, `amendCostUsd` are `number | null`.
- `src/substrate/dispatch/index.ts` — the context's public surface; `Dispatch` and `DispatchState` are exported there.

Do not read beyond these. This is a pure function — no I/O, no database, no rendering.

## Contract (exact — must produce)

```ts
export interface Readout {
  total: number;              // all dispatches passed in
  reachedReady: number;       // state === "done"
  escalated: number;          // state === "escalated"
  failed: number;             // state === "failed"
  inFlight: number;           // not yet terminal (queued/building/review/amending)
  cheapAbleFraction: number;  // reachedReady / (terminal count); 0 when no terminal dispatches
  blendedCostPerReadyUsd: number; // (Σ every leg cost over ALL dispatches) / reachedReady; 0 when reachedReady === 0
  totalCostUsd: number;       // Σ (buildCostUsd + reviewCostUsd + amendCostUsd) over all dispatches, nulls as 0
  amendRoundsHistogram: Record<number, number>; // amendRounds value → count of dispatches with it
}

export function cheapAbleFraction(dispatches: Dispatch[]): Readout;
```

## Pre-resolved design decisions (do NOT deviate)

- **Terminal = `done` + `escalated` + `failed`.** `cheapAbleFraction` denominator is the terminal count (in-flight dispatches are undecided and excluded). If terminal count is 0, `cheapAbleFraction` is `0` (never `NaN`).
- **`blendedCostPerReadyUsd`** = total cost across *all* dispatches (escalated/failed ones still cost money) divided by `reachedReady`. If `reachedReady` is 0, it is `0` (never `NaN`/`Infinity`).
- **Null costs count as 0** — sum `(x ?? 0)` for each leg.
- **`amendRoundsHistogram`** keys are the distinct `amendRounds` values present (e.g. `{0: 2, 1: 1}`); a value with no dispatches is absent (do not pre-seed 0..N).
- **Empty input** → every numeric field `0`, `amendRoundsHistogram` `{}`. No throws.
- Iterate once; derive everything from the single pass or simple filters — clarity over cleverness.

## Acceptance

`bun run typecheck` and `bun test` both green, with `readout.test.ts` covering:
- empty input → all zeros, `{}` histogram, no `NaN`.
- a mix (e.g. 2 `done`, 1 `escalated`, 1 `failed`, 1 `building`): `total` 5, `reachedReady` 2, `inFlight` 1, `cheapAbleFraction` = 2/4 = 0.5.
- cost summing with some null legs → correct `totalCostUsd` and `blendedCostPerReadyUsd`.
- `amendRoundsHistogram` over dispatches with differing `amendRounds`.

## Out of scope

Rendering/formatting (that is `status.ts`), reading the database, persistence, currency/locale formatting. This function takes `Dispatch[]` and returns numbers.
