# 0017 — Substrate module architecture: bounded contexts + a layered split

- **Status:** proposed
- **Date:** 2026-06-07

## Context

ADR 0003 chose TypeScript/Bun and left the module boundaries open; `docs/standards.md`
§ Module organization sketched a by-responsibility directory split (`dispatch/`, `wake/`,
`github/`, `substrate/`, `util/`) but did not name an internal architecture. When the
first real persistent domain landed — the dispatch registry (ADR 0009/0016) — it was
dumped as three flat files in `substrate/` with the data-access class mislabeled a
"registry," and owner review (PR #41) flagged the absence of a recognized pattern: *are
we following router/service/repository/engine? does the registry belong in its own
subdirectory, or is that what `substrate/` is?* This ADR answers that, so the question is
settled once rather than re-litigated per module, and so the cheap builder has an explicit
rule for "which layer am I writing, and where does it go."

## Decision

The substrate is organized as **bounded contexts**, each owning an explicit **layered
split**.

- **A context owns its layers in one directory** under `substrate/` (the dispatch context
  is the first: `substrate/dispatch/`), exposing a public surface through an `index.ts`.
  `substrate/` holds contexts; it is not itself a context. A new persistent domain (the
  planner's tables, ADR 0010) becomes a sibling context directory, not more flat files.
- **The layers, named explicitly** — engine / repository / service / router:
  - **engine / domain** (`<context>/model.ts`) — pure logic and types: the state machine,
    the transition graph. No I/O, no ORM imports.
  - **persistence** (`<context>/schema.ts`) — the Drizzle table, schema as code (ADR 0016).
  - **repository** (`<context>/repository.ts`) — the only layer that touches the database;
    returns domain objects, owns transactions. The dispatch registry (the ADR 0009 product
    concept) is realized as `DispatchRepository`.
  - **service** (`src/dispatch/` today — the legs, the loop daemon, the amend cycle) —
    orchestration: consumes repositories and the OpenCode adapter; holds **no SQL**.
  - **router** — thin entry (CLI / daemon bootstrap; later HTTP).
- **The load-bearing invariant: SQL lives only in a repository.** A service-layer module
  calls `repository.transition(...)`, never a query builder. This is what keeps the cheap
  tier's service code (the bulk of the build work) free of persistence detail.

The operational rule lives in `docs/standards.md` (§ Module organization → Layering); the
`adding-a-substrate-module` and `persistence-drizzle` skills point at it. This ADR is the
decision of record behind them.

## Consequences

- #33 (the loop daemon) and #34 (the amend cycle) are built **as the service layer** —
  consuming `DispatchRepository`, holding no SQL — rather than reaching into the db.
- Each new persistent domain is a context directory with the same internal shape, so the
  structure scales by repetition, not by growing a flat pile.
- The cheap builder gets a mechanical placement rule (identify the layer → place in the
  context dir), reducing the judgment it has to exercise.
- A mild cost: small domains carry a few files (model/schema/repository/index) where one
  would have sufficed. Accepted — the seams are the point, and they pay off as a context
  grows a service layer and a second table.

## Alternatives considered

- **By-responsibility only (the prior sketch).** What we had — `substrate/` as a flat bag.
  Rejected: it separates *kinds* of module but not the *layers* within a domain, which is
  exactly what let the registry land as undifferentiated flat files.
- **Layer-first top-level directories** (`repository/`, `service/`, `engine/`). Rejected
  for this size: a `repository/` directory with one file is ceremony; context-first keeps
  a domain's pieces together and reads better until there are many contexts.
- **A framework that imposes the layering** (Nest-style). Rejected: a heavy dependency and
  a runtime we don't need; the split is a convention, enforced by review + the skills, not
  by a framework.

## Open questions

- Where the service layer ultimately lives as it ports: the existing `src/dispatch/` legs
  vs. converging into `substrate/<context>/service/`. Decided as #33/#34 land.
- Whether `router` warrants its own directory now or stays the thin `index.ts` entrypoint
  until an HTTP surface (ADR 0015's UI) actually needs it.
