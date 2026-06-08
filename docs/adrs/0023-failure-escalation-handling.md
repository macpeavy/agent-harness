# 0023 — Every failure escalates and parks; nothing wedges silently

- **Status:** proposed
- **Date:** 2026-06-08
- **Refines:** 0008 (the amend cycle's escalation, made exhaustive), 0020 (the session-orchestrator's signal-on-escalation, made a first-class contract rather than a ride-along bullet).

## Context

Dogfooding the harness on `fleet-status-viewer` (PR #102) wedged a session silently: chunk C2 (`cli/status.ts`) was marked terminal `failed`, its dependent C3 blocked behind it forever, and the loop spun emitting nothing. Two things were already decided and got lost in the build:

- **Park over fail** (ADR 0008, and a load-bearing owner principle): escalation is non-terminal — escalate→pause→rewake. Yet the build leg hard-fails.
- **Signal the chief on escalation** (ADR 0020): the session-orchestrator advances the DAG and signals on completion *or escalation*. Yet the session loop only handles all-success.

They got lost because failure handling was never written down as one thing. It was scattered: the review path escalates correctly, the build path hard-fails, the session loop knows only "all done." No single place enumerated *every* way a chunk fails to reach `done` and what must happen for each. This ADR is that place. The taxonomy below is the contract; if a failure mode isn't in it, that's a gap to add here — not a behavior to invent in code.

The triggering no-op is itself a named failure class: the cheap builder explored the repo and emitted "Task completed" with **zero file edits** — a false-success no-op. Detectable (empty diff), invisible to the strong reviewer (no diff to review), and recoverable (re-decompose / tier-promote) — so it must park, not die.

## Decision

**The invariant.** A chunk-level outcome is *never* terminal `failed` when it is recoverable. Every recoverable non-success **escalates → parks** (non-terminal, chief-visible, with a reason). Terminal `failed` is reserved for the genuinely unrecoverable substrate condition (the repo/worktree is gone, the DB is corrupt) — not for anything the chief can route. A session **never** stays in `building` once any of its chunks reaches a parked or terminal state; it transitions to a needs-attention state and signals.

**The exhaustive taxonomy.** Every way a chunk fails to reach `done`, its detection point, and its required handling:

| # | Failure mode | Detected at | Required handling | Recovery |
|---|---|---|---|---|
| 1 | **No-op build** — builder changed nothing (incl. false "Task completed") | build leg (`daemon.ts:143`, empty `git status`) | escalate→park, reason `no-op` | `redecompose` / `promote` |
| 2 | **Leg error** — worktree/install/agent throw | daemon `fail()` (`daemon.ts:249`) | escalate→park, reason `error` (+ message) | `redecompose` / `promote` / retry |
| 3 | **Model-turn timeout** | daemon `escalateTimeout` | escalate→park, reason `attended` | `promote` / `redecompose` |
| 4 | **Amend cap exceeded** — review keeps finding blockers | review loop | escalate→park, reason `re-decompose` | `redecompose` |
| 5 | **Builder can't action an owner note** | amend leg | escalate→park, reason `attended` | chief/owner |
| 6 | **Unrecoverable substrate error** — repo/DB gone | any leg | terminal `failed` (the only legitimate use) | operator |
| 7 | **A chunk reached a parked/terminal state** (1–6) | session loop `recordOutcomes` | session → needs-attention; signal chief + owner; stop spinning | route the chunk, then resume |

Rows 3–5 are already correct (ADR 0008). Rows 1, 2, 7 are the gaps this ADR closes. Row 6 narrows terminal `failed` to its only legitimate meaning.

**The session-level rule (row 7).** `recordOutcomes` today advances to `review` only when every chunk is `done`/`superseded`. It gains the symmetric branch: if any chunk is in a parked (`escalated`) or terminal (`failed`) state, the session leaves `building` for a needs-attention state and emits the escalation signal — within one tick, never an extra idle loop. The DAG does not silently stall: a blocked dependent is reported as blocked, not hidden.

**The chief-vocabulary rule.** Every parked reason in the taxonomy is surfaced by `status` and routable by `redecompose` / `promote` / `address`. A parked chunk is never outside the chief's reach. (The bug that made terminal-`failed` C2 unroutable is a direct consequence of violating the invariant — fixing the invariant fixes the reachability.)

## Consequences

- A failure path that was scattered across three modules is now one enumerated contract. Adding a failure mode means adding a row here first, then implementing it — the ADR is the guard against the next silent gap.
- `failed` nearly disappears from the chunk lifecycle; the common case is `escalated` (parked, recoverable). This matches the owner's park-over-fail principle structurally, not just in spirit.
- A wedged session becomes impossible: any non-success surfaces within one tick.
- A new `no-op` escalation reason enters the vocabulary and the cost/quality instrument — a counter worth watching (false-success no-ops are cheap-able-fraction signal, ADR 0014).

## Alternatives considered

- **Just fix the C2 case (no-op → park).** Rejected — fixes one row, leaves the leg-error row and the session-loop row to bite next. The whole point is the exhaustive table.
- **Re-prompt a no-op builder once before parking** ("you claimed done but changed nothing — write the file"). A reasonable mitigation; deferred to an open question rather than baked in, because it spends another cheap turn on a builder that may keep no-op'ing. Decide with instrument data.
- **Keep terminal `failed` for build failures.** Rejected — it's the bug. Terminal-failed is unrecoverable-only.

## Open questions

- **Re-prompt-once on no-op** before escalating, or escalate immediately? Lean: escalate immediately now (cheap, deterministic); revisit if the instrument shows a re-prompt cheaply rescues a meaningful fraction.
- **The needs-attention session state name** (`escalated`? `blocked`? `needs-attention`?) and whether it's distinct from a session whose build merely completed — the signal must distinguish "ready for review" from "stuck, route me."
- **Whether row 2 (leg error) deserves a bounded auto-retry** before parking (transient install/network blips) vs. parking straight to `attended`.
