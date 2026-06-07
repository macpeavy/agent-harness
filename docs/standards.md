# Coding standards — agent-harness

The rules every change in this repo follows. Written to be held to — by the cheap
builder especially, which has less judgment than a strong model and leans on these
being explicit. Read this before writing code; it ships in every chunk's context pack.

`CLAUDE.md` orients (what the project is, the phase, where things go). This file is the
detailed standard. The `docs/skills/` directory operationalizes the recurring
"how do I add X" operations; reach for the matching skill when you add a surface.

## Language & runtime

- **TypeScript on Bun. One runtime.** No second runtime, no Node-only APIs where a Bun
  built-in exists. Bun ≥ 1.1.0, ESM (`"type": "module"`).
- **Strict TS, and it must pass.** `tsconfig.json` sets `strict` + `noUncheckedIndexedAccess`.
  Run `bun run typecheck` (`tsc --noEmit`) before every commit; a change that doesn't
  typecheck is not done.
- **No `any`.** Type the value. For foreign JSON you can't control (an API response),
  cast to a local shape and default every field — see § Typed boundaries and the
  `typed-api-boundary` skill. `unknown` at the boundary, narrowed before use, beats `any`.
- **Prefer Bun built-ins over dependencies.** `fetch`, `Bun.sleep`, `Bun.$` (shell),
  `bun:sqlite`, `bun:test`, `import.meta.main` are all first-class. Add a dependency only
  when a built-in genuinely won't do; the substrate is deliberately near-dependency-free.
  The **sanctioned exceptions** are the data layer — **Drizzle ORM** (`drizzle-orm` +
  `drizzle-kit`), ADR 0016 — and a typed client generated from an OpenAPI spec. Reach for
  a new dependency beyond these only with an ADR.

## Module organization

The substrate (`src/`) is organized by responsibility, one concern per directory:

```
src/
  index.ts            # entrypoint / CLI for the substrate
  opencode/           # typed client, serve, agent-runner (run a named agent in a worktree)
  dispatch/           # the service layer: the loop daemon + legs/ (build/review/amend)
  wake/               # idle detection + prompt_async wake driver
  github/             # gh/git plumbing, PR creation, the merge gate
  substrate/          # durable state + domain, organized by context (see below); the
                      #   contexts are sibling tables in one shared db (.substrate/substrate.db)
                      #   so cross-context links are real FKs — independent repos, service binds
    dispatch/         #   the dispatch context: model (engine) + schema + repository
    plan/             #   the plan context: features + chunk-DAG (ADR 0019), sibling to dispatch
  util/               # small, dependency-free, single-purpose helpers
```

(This resolves ADR 0003's open module-boundary question; extend the shape as the
substrate grows, but keep the by-responsibility split.)

### Layering — the substrate is a layered backend

Persistent-state code follows the **engine / repository / service / router** split,
named explicitly (ADR 0017). A bounded *context* (the dispatch context is the first) owns
its layers in one directory under `substrate/`, with an `index.ts` as its public surface.
`substrate/` holds contexts; it is not itself a context.

- **engine / domain** (`substrate/dispatch/model.ts`) — pure logic and types: the state
  machine, the transition graph. No I/O, no ORM imports.
- **persistence** (`substrate/dispatch/schema.ts`) — the Drizzle table, schema as code.
- **repository** (`substrate/dispatch/repository.ts`) — the *only* layer that touches the
  database. Returns domain objects, owns transactions. The dispatch registry (ADR 0009)
  is realized as `DispatchRepository`.
- **service** (the loop daemon, the amend cycle — `src/dispatch/`) — orchestration:
  consumes repositories + the OpenCode adapter, holds no SQL.
- **router** — thin entry (CLI / daemon bootstrap, later HTTP).

The rule a service-layer change must hold: **SQL lives only in a repository.** A leg or
the loop calls `repository.transition(...)`, never a query builder.

- **One responsibility per module.** A file does one job and says so in its top comment.
- **One file per chunk.** A unit of build work targets a single file (the natural chunk
  boundary — see ADR 0014). Don't sprawl a change across many files; if it needs to,
  it's more than one chunk.
- **Helpers stay local until reused.** A function used in one module is not exported
  (e.g. `slugify` in `dispatch/legs/build.ts`). Promote to `util/` only on the second use.
- **Imports are relative within `src/`** (`../opencode/client`), no path aliases.
- **Published contracts get their own file; one-off types stay co-located.** A type that
  is the shared contract between modules — the dispatch domain model and state machine
  consumed by the loop and the amend leg — lives in its own file (`substrate/dispatch/model.ts`)
  that consumers import (via the context's `index.ts`). A type used only by its own module (a function's option bag, a
  local result shape) stays at the top of that module. Same instinct as helpers: shared
  surface earns a file, local surface doesn't.

## Types & boundaries

- **Export types as `interface`; behavior as `function`/`class`.** Name types
  PascalCase, functions/vars camelCase, files kebab-case (`agent-runner.ts`).
- **Every exported function has an explicit return type** (`Promise<string>`,
  `: string[]`). Don't rely on inference at a module boundary.
- **Typed boundaries: cast foreign JSON to a local shape and default every field.**
  An external API (the OpenCode server) returns untyped JSON. Cast it to an inline
  shape with optional fields, then read with `?? <default>` so a missing field can't
  throw downstream. This is the load-bearing pattern in `opencode/client.ts`; see the
  `typed-api-boundary` skill. **This is for foreign JSON (HTTP) only** — database rows are
  *not* a cast boundary: Drizzle infers the row type from the schema, so a query returns
  the typed model with no cast (see § Persistence).
- **The substrate is the seed of the production system, not a POC.** Real modules,
  clear seams, typed boundaries. No disposable scripts.

## Error handling

- **Fail loud, with context.** Throw `new Error(...)` whose message names what failed
  and the inputs: `throw new Error(\`POST ${path} → ${res.status} ${await res.text()}\`)`.
  A thrown error a human can diagnose from the message beats a silent wrong result.
- **Validate at the boundary and throw.** Check the thing that can be wrong as soon as
  you have it (`if (!s?.id) throw new Error(...)`), not three calls later.
- **No silent catches.** Don't `catch {}` to swallow. If you catch, either handle
  meaningfully or rethrow with added context. The one allowed "swallow" is deliberate
  idempotent cleanup (`.nothrow()` on a `git worktree remove` that may not exist) — and
  it's explicit, not a bare try/catch.
- **`requireEnv` for required config; `?? default` for optional.** Use
  `util/env.ts`'s `requireEnv(name)` (throws, naming the missing var) for config that
  must be present; `process.env.X ?? fallback` for genuinely optional config.

## Async, processes & the harness boundary

- **`await` real async; don't fake it.** Use `Bun.sleep` for delays, not busy loops.
- **Subprocess + git/gh via `Bun.$`.** Use the shell template with `.cwd()`, `.quiet()`,
  `.text()`, `.nothrow()`. Make destructive setup idempotent: clear prior state with
  `.nothrow().quiet()` before creating (the build-leg's worktree/branch reset).
- **The substrate owns git + GitHub; the agent owns the code.** A build agent edits
  files in its worktree and never runs git or opens a PR — the substrate commits,
  pushes, and creates the PR. Keep that boundary; it's why the build-leg prompt tells
  the builder not to touch version control.
- **The wake is external.** Idle detection and re-activation live in the substrate
  (`waitForReply` polls; `promptAsync` fires), never inside an OpenCode plugin
  (ADR 0004). Don't try to drive the loop from inside the harness.

## Persistence

Durable state goes through **Drizzle ORM over `bun:sqlite`** (ADR 0016). See the
`persistence-drizzle` skill for the full pattern; the rules:

- **Schema as code is the source of truth.** Define tables in the context's `schema.ts`
  (`substrate/dispatch/schema.ts`) with camelCase TS keys mapped to snake_case columns, so
  the inferred `InferSelectModel` type *is* the domain model — no row→object mapper, no `as`
  cast. The **repository** is the only layer that imports the schema or the query builder.
- **No hand-written SQL strings.** Reads and writes go through Drizzle's typed query
  builder. The only allowed `sql` fragments are for things SQLite exposes but the schema
  doesn't model — an in-place increment, a `rowid` tiebreak — and even then values are
  bound, never interpolated.
- **Migrations are generated and committed.** `bun run db:generate` (drizzle-kit) emits
  SQL into `drizzle/`; the store applies pending migrations at startup. A schema change
  ships its generated migration in the same PR, reviewed as SQL.
- **Transactions wrap every read-validate-write and multi-field write** (`db.transaction`).
  A state-transition guard reads, validates against the graph, and writes as one atomic
  unit. Enable WAL on the underlying handle for concurrent reads.
- **The db lives under `.substrate/`** (gitignored, inside the sandbox volume — ADR 0007);
  the registry sits *above* OpenCode's session store and never duplicates session data.

## Testing

- **`bun:test`, co-located.** A module `foo.ts` is tested by `foo.test.ts` beside it.
  Import from `"bun:test"` (`describe`, `it`, `expect`). Run `bun test`.
- **One behavior per `it`.** Test the happy path and the edges that matter — empty
  input, whitespace, the throw. See `util/parse-routes.test.ts` as the shape to match.
- **Assert the error message, not just that it throws** (`.toThrow("parseRoutes: no
  routes parsed")`) so a future refactor that changes *why* it throws is caught.
- **A chunk ships with its tests.** Acceptance for a build chunk includes a passing
  test file; `bun test` and `bun run typecheck` both green is the bar.

## Secrets & config

- **Secrets come from the environment, never committed.** Names go in `.env.example`;
  real values in `.env` (gitignored). LiteLLM and OpenCode read keys via env only.
- **The valuable credential never reaches the agent.** The OpenRouter key lives only in
  the gateway's env; OpenCode holds the local gateway master key (ADR 0002/0007). Don't
  add code paths that put an upstream key where an agent can read it.
- **Never weaken the permission floor or the deny rules** in `opencode.json` to make
  something work; they're defense-in-depth (ADR 0007). If a build needs a denied command,
  that's a surface decision, not a config loosening.

## Comments & commits

- **Top-of-file comment on every module:** what it is, its role/lineage, and a `Run:`
  line if it's runnable. `//` prose, "why" over "what".
- **JSDoc (`/** ... */`) on exported methods** — one line of purpose plus any gotcha
  (`"the token-free wake. Returns 204, no body."`). Match the surrounding comment density.
- **Commits are scoped and conventional:** `type(scope): summary` (`feat`, `fix`,
  `refactor`, `chore`, `docs`, `test`). One coherent change per commit; the substrate's
  build-leg uses `feat: <title> (<issue-id>)`. See the `opening-a-pr` skill.

## The bar

A change is done when: it typechecks (`bun run typecheck`), its tests pass (`bun test`),
it touches one surface, it follows the patterns above, and it reads like the code already
in the repo. Match the surrounding code's idioms over your own preferences.
