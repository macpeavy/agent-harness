# 0009 — Dispatch registry persistence, and the cheap-able-fraction instrument

- **Status:** proposed
- **Date:** 2026-06-07
- **Superseded in part by:** 0016 — the persistence *mechanism* is now Drizzle over bun:sqlite, not raw `bun:sqlite`/no-ORM/no-deps. Every other decision below (above-OpenCode layering, the state machine, crash recovery, the instrument columns) stands.

## Context

The substrate's unit of work is a **dispatch**: one chunk of work carried through build → review → amend → PR. The substrate needs durable state for dispatches — to survive a crash, to resume incomplete work, to link the OpenCode sessions a dispatch spawned, and to know what is in flight. The spike built an informative version of this (PR #28, a `bun:sqlite` registry) deliberately as a *heavy-work test subject*, not a ratified design — its own review surfaced real gaps (an atomicity bug, a hardcoded state list). The port designs it properly.

A second need rides on the same surface. The thesis verdict (`docs/spike-results.md`) hinges on the **cheap-able fraction** — how much work reaches mergeable on the cheap tier within the amend cap — which is only knowable by measuring real dispatches. The registry already records per-dispatch state; making it also record route, amend rounds, escalations, and cost turns it into the measurement instrument the verdict needs. The persistence store and the cost instrument are one artifact.

## Decision

A dispatch registry owned by the substrate, sitting **above** OpenCode's own session store — it links session ids, it does not duplicate session or message data. Embedded, single-process, no server. (The mechanism was raw `bun:sqlite`; ADR 0016 now realizes it through Drizzle over that same `bun:sqlite` driver — the layering and contract below are unchanged.)

- **Dispatch-level state, not session data.** Each row is a dispatch with its issue/chunk identity, branch, current state, the linked OpenCode `build`/`review` session ids, PR url, and cost. Session transcripts and messages stay in OpenCode's store, read through it when needed.
- **State machine:** `queued → building → review → amending → done`, with `building`/`review`/`amending` able to go to `escalated` (cap exceeded, ADR 0008) or `failed`. Transitions are validated against the allowed graph and rejected if illegal; the transition + `updated_at` write is wrapped in a transaction. (The spike's atomicity finding is a design requirement here, not an afterthought.)
- **Crash recovery:** `resumeIncomplete()` returns dispatches in non-terminal states so the daemon (P1) can resume after a restart.
- **The measurement instrument:** each dispatch additionally records `route` (which model built it), `amend_rounds`, `escalated` (and to what — re-decompose / tier-promote / attended), and `cost_usd` per leg. Over a corpus this yields the cheap-able fraction, the amend-round distribution, and the blended cost-per-PR — the P4 readouts.
- **Prepared statements** throughout; the db path defaults under `.substrate/` (the substrate's own runtime-state dir, mirroring `src/substrate/`) and is treated as containable state (it lives inside the sandbox volume — ADR 0007).

## Consequences

- The substrate has durable, crash-recoverable dispatch state with a clean separation from the harness's session store — no duplication, a defined linking seam.
- The same table is the cost-and-quality ledger; P4's verdict reads from it rather than from bespoke instrumentation bolted on later.
- The schema is a load-bearing contract between the loop, the amend cycle, and the planner (which reads escalation signals to learn decomposition). It is versioned and migrated deliberately.
- SQLite's single-writer model is fine for one substrate process; WAL mode (the spike builder added it unprompted) covers concurrent reads from a status surface (ADR 0006's thin read).

## Alternatives considered

- **Reuse OpenCode's session store as the dispatch store.** Rejected — it is session/message data at the wrong altitude; a dispatch spans multiple sessions (build, reviews, amends) and carries state OpenCode has no concept of. Link to it, don't overload it.
- **A JSON file / flat log.** Rejected — no transactional transitions (the atomicity gap), no query, no concurrent-read story. SQLite is the right weight.
- **A separate metrics store for the instrument.** Rejected — bolting measurement on later loses the per-dispatch join and risks drift; the dispatch row already has the identity to hang metrics on.

## Open questions

- Schema versioning/migration strategy as the dispatch lifecycle grows (e.g. when sub-chunks/DAG edges land with the planner).
- Whether chunk-DAG structure (parent feature → child chunks) lives in this registry or a sibling planning table — likely sibling, decided with ADR 0010's implementation.
- Retention: how long terminal dispatches are kept for the cheap-able-fraction analysis before archival.
