# Chunk SHAKE-2 — display format helpers

**Tier:** cheap (default). **Surface:** one new file `src/util/format.ts` + its co-located test `src/util/format.test.ts`.

## Intent

Two small, pure, typed display helpers — USD and duration — so the rest of the substrate stops hand-rolling `.toFixed`.

## Context pack — read these first

- `docs/standards.md` — the coding standard (typed boundaries, explicit return types, `bun:test`).
- `.claude/skills/writing-tests.md` — the test convention.
- `src/util/parse-routes.ts` and `src/util/parse-routes.test.ts` — the shape to match: a small, single-purpose, dependency-free `util/` helper plus its co-located test. Mirror this style exactly.

Do not read beyond these.

## Contract (exact — must produce)

```ts
/** Format a USD amount with a leading $ and 4 decimals, e.g. 0.0023 -> "$0.0023". */
export function formatUsd(usd: number): string;

/** Format a millisecond duration compactly, e.g. 450 -> "450ms", 2_300 -> "2.3s",
 *  83_000 -> "1m 23s", 3_725_000 -> "1h 2m". */
export function formatDuration(ms: number): string;
```

## Pre-resolved design decisions (do NOT deviate)

`formatUsd`:
- Always `"$" + usd.toFixed(4)`. `0` → `"$0.0000"`. Negative is not expected; format as given.
- Non-finite (`NaN`/`Infinity`) → `"$0.0000"` (guard so a bad input can't render garbage).

`formatDuration` — pick the unit by magnitude, exactly these bands:
- `< 1000ms` → whole milliseconds, `"<n>ms"` (e.g. `"450ms"`, `"0ms"`).
- `< 60_000ms` → seconds to one decimal, `"<s>s"` (e.g. `2_300` → `"2.3s"`).
- `< 3_600_000ms` → whole minutes + whole seconds, `"<m>m <s>s"` (e.g. `83_000` → `"1m 23s"`). Round seconds **down** (floor).
- `>= 3_600_000ms` → whole hours + whole minutes, `"<h>h <m>m"` (e.g. `3_725_000` → `"1h 2m"`). Floor.
- Negative or non-finite → `"0ms"`.

## Acceptance

`bun run typecheck` and `bun test` both green, with `format.test.ts` covering:
- `formatUsd`: a normal value (`0.0023` → `"$0.0023"`), zero, rounding (`0.00125` → `"$0.0013"` per `toFixed`), a non-finite guard.
- `formatDuration`: one case in each band (ms, s-with-decimal, m+s, h+m), `0` → `"0ms"`, and a negative → `"0ms"`.

## Out of scope

Locale/i18n, thousands separators, other units (bytes/percent), adaptive USD precision. Exactly these two functions, exactly these rules.
