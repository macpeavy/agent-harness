---
name: adding-a-substrate-module
description: Use when adding a new TypeScript module to the substrate (src/) — a dispatch leg, a wake driver, a github helper, a registry. Establishes the file shape, exports, and tests so it matches the existing substrate.
---

# Adding a substrate module

**When:** you're adding a new `.ts` file under `src/` — a new dispatch leg, a wake/idle
module, a github plumbing helper, a registry, anything that's part of the orchestrator.

**Files:** the new module under the right `src/` subdirectory by responsibility
(`dispatch/`, `wake/`, `github/`, `opencode/`, `substrate/`, `util/`), plus its
co-located `*.test.ts`. Don't touch other modules unless the chunk says so.

## How

1. **Pick the directory by responsibility** (§ Module organization in `docs/standards.md`).
   A new build/review/amend leg → `dispatch/`. Idle detection → `wake/`. Git/PR → `github/`.
2. **Open with a top comment**: what the module is, its role/lineage, and a `Run:` line
   if it has an `import.meta.main` entrypoint.
3. **Export types as `interface`, behavior as `function`/`class`**, every exported
   function with an explicit return type. Keep helpers local (not exported) until reused.
4. **Fail loud** — throw `new Error(...)` with context at every boundary; no silent catches.
5. **Use Bun built-ins** (`fetch`, `Bun.$`, `Bun.sleep`) over dependencies. For durable
   state, the data layer is Drizzle — see the `persistence-drizzle` skill (ADR 0016).
6. **Write the co-located test** (`writing-tests` skill). `bun test` and `bun run
   typecheck` must pass.

## Worked example

A new leg `src/dispatch/amend-leg.ts` (the build→review→amend loop, ADR 0008):

```ts
// AGENT-20 — amend leg.
//
// Given a review with blocking findings, re-dispatch the builder with the findings
// as the amend prompt, re-review, repeat to a clean review or the cap. Grows from
// review-leg.ts; the substrate owns the loop, the registry records each round.

import { OpencodeClient } from "../opencode/client";

export interface AmendResult {
  rounds: number;
  clean: boolean;
  escalated?: "re-decompose" | "tier-promote" | "attended";
  tokens: { input: number; output: number };
}

const AMEND_CAP = Number(process.env.AH_AMEND_CAP ?? "3");

export async function runAmendLeg(/* ... */): Promise<AmendResult> {
  // ... cap-bounded loop; throw with context on a failed dispatch; record each round
}
```

Note the shape: top comment with lineage, `interface` for the result, explicit return
type, config via `process.env.X ?? default`, the cap as a named constant.
