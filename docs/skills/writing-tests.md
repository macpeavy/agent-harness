---
name: writing-tests
description: Use when writing tests for a substrate module. The bun:test conventions — co-located, one behavior per case, assert the error message, cover the edges.
---

# Writing tests

**When:** any build chunk — a chunk ships with its tests. Acceptance is `bun test` and
`bun run typecheck` both green.

**Files:** a co-located `*.test.ts` beside the module it tests (`foo.ts` → `foo.test.ts`).

## How

1. **Import from `"bun:test"`** — `describe`, `it`, `expect`. Run with `bun test`.
2. **Co-locate.** The test lives next to the module, not in a separate `test/` tree.
3. **One behavior per `it`**, named for the behavior ("strips surrounding whitespace").
4. **Cover the happy path and the edges that matter** — empty input, whitespace, the
   throw. Don't test the language; test the module's decisions.
5. **Assert the error *message*, not just that it throws** (`.toThrow("parseRoutes: no
   routes parsed")`) — so a refactor that changes *why* it throws is caught, and it
   documents the contract.
6. **For stores/IO, use a temp path and clean up** (a temp db file; remove it after) so
   tests don't collide or leave state.

## Worked example

`src/util/parse-routes.test.ts` — the shape to match:

```ts
import { describe, expect, it } from "bun:test";
import { parseRoutes } from "./parse-routes";

describe("parseRoutes", () => {
  it("splits a normal CSV", () => {
    expect(parseRoutes("a, b, c")).toEqual(["a", "b", "c"]);
  });
  it("strips surrounding whitespace", () => {
    expect(parseRoutes("  foo , bar  ,  baz ")).toEqual(["foo", "bar", "baz"]);
  });
  it("throws on whitespace-only input", () => {
    expect(() => parseRoutes("  , , ")).toThrow("parseRoutes: no routes parsed");
  });
});
```

Happy path, an edge (whitespace), and the throw — each asserting a specific outcome.
