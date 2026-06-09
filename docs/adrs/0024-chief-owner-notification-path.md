# 0024 — The chief/owner notification path: asymmetric push, no chief poll

- **Status:** proposed
- **Date:** 2026-06-08
- **Refines:** 0023 (row 7's "signal chief + owner" — made a real push, not a console line), 0020 (the completion signal — made a real owner notify). **Builds on:** 0004 (the external wake — applied to the chief, not just the builder/reviewer).

## Context

ADR 0023 made a session move to `needs-attention` when any chunk parks/fails, and ADR 0020 moves it to `review` when its build completes — so a session can no longer wedge in `building`. But both "signals" are **pull-only**: the event is a session-state change visible only when something calls the `status` MCP tool, plus a `console.warn` in the session-loop pane. Nothing programmatically reaches the chief or the owner. They learn a session needs routing — or is ready to merge — only by looking.

This is structural, not an oversight. The chief is a passive OpenCode agent: it acts when prompted, has no inbox or event channel, and the architecture deliberately keeps it from idling or babysitting (it is the expensive strong-tier seat). The substrate's external wake (`promptAsync` + `waitForReply`, `src/opencode/client.ts`) already drives token-free builder/reviewer turns — but it has never been pointed at the chief. There is no prism/Linear/webhook emitter from the loop either.

Two events need to reach a human-or-agent who can act:
- **failure/escalation** — a chunk parked, session → `needs-attention`. The actor is the **chief** (it routes via `redecompose` / `promote` / `address`).
- **completion** — session → `review`, a PR is ready. The actor is the **owner** (they merge on GitHub, the load-bearing gate).

## Decision

**Asymmetric routing by actor.** The two events have different actors, so different recipients and different channels. This is the load-bearing choice.

| Transition | Recipient | Channel | Why |
|---|---|---|---|
| `building → needs-attention` | **chief** | `promptAsync` wake into the chief's session | Routing a parked chunk is chief work (autopilot between the owner's two gates). |
| `building → review` | **owner** | a `Notifier` seam (default: the console line) | Merging is owner work; the chief has nothing to do — waking it spends strong tokens for nothing. |

**No chief poll loop.** The chief is *push-woken only*. It spends strong-tier tokens exactly when (a) the owner prompts it, or (b) the loop wakes it with a real event — never on a timer, never idling. A poll loop is rejected outright: it burns the most expensive seat to mostly find nothing. This is ADR 0004's external wake applied to the chief.

**1. A chief-session registry (so the loop knows where to push).** The chief, at session start, registers its OpenCode session id into the substrate DB (a single `chief_registration` row, written through a repository — SQL only in a repository, ADR 0017). The loop reads it to address the wake. Registration is best-effort and self-healing: a `promptAsync` that fails (no chief registered, chief gone, pane closed) is swallowed — the durable state + console line + `status` pull remain the floor. **Push is an accelerator on top of pull, never the system of record.**

**2. A notify pass in the loop (deterministic, no model).** Each tick, after `recordOutcomes`, the loop selects sessions that have *just* entered a signalling state and fires once:
- `needs-attention` → if a live chief is registered, `promptAsync(chiefSessionId, payload)`.
- `review` → the `Notifier` (default: console; pluggable later).

The pass is pure mechanism — an HTTP `promptAsync` and a console write. The *recipient* is a model (the chief); the *loop* never is.

**3. The signal carries enough to act without first calling `status`.** The wake payload is self-contained:
- needs-attention → `{ sessionId, featureId, featureTitle, parked: [{ chunkId, surface, reason }], verbs: [redecompose|promote|address] }`. The chief can begin routing from the payload; it may still call `status` for full context, but it isn't forced to round-trip just to learn *what* happened.
- review → `{ sessionId, featureTitle, prNumber, prUrl, chunkCount, costUsd }`. The owner can go merge without asking.

**4. Idempotency — one signal per transition, never per tick.** A nullable `signaled_at` timestamp on the session, set through a repository. The notify pass selects signalling-state sessions with `signaled_at IS NULL`, fires, then stamps. `needs-attention → building` (the chief routed it) clears `signaled_at`, so a *re-park* re-signals. This decouples the transition (in `recordOutcomes`) from the notify (a separate idempotent pass), making it crash-safe and exactly-once: the loop can die and restart between transition and push without double-firing or dropping. The `console.warn` in `recordOutcomes` becomes a debug log; the authoritative signal is the notify pass.

**5. The owner channel stays decoupled and pluggable.** The default `Notifier` is the existing console line — the owner already watches the fleet's logs pane, and GitHub itself notifies on the open PR. A richer owner channel (OS/desktop notification, a chat relay) is a `Notifier` implementation added later without touching the loop. **The loop is not wired to prism** — agent-harness is the stack that sheds prism coupling (discovery framing: "does agent-harness need a prism equivalent? leans no"); re-introducing it through the notify path would undo that on purpose-built infrastructure.

## Consequences

- The chief is reached the moment a session needs routing, without polling — strong tokens spent only on real work. The expensive seat stays idle-free.
- The owner is reached on review-ready without the chief being involved at all.
- A new registry row + a `signaled_at` column + a notify pass + a `Notifier` seam. Modest, all within the existing loop/repository shape.
- Push depends on a live registered chief; when absent, the system degrades to exactly today's pull behavior — no regression, just no acceleration. This is intentional: correctness lives in the durable state, latency-to-action lives in the push.
- A precedent: the external wake now drives *three* roles (builder, reviewer, chief), confirming ADR 0004 generalizes.

## Alternatives considered

- **Chief poll loop.** Rejected — burns the strong tier idling to mostly find nothing; the exact babysitting the architecture forbids.
- **Pull-only (status quo).** Rejected as the *only* path — that's the gap; chief/owner act only when they look. Kept as the durable floor beneath the push.
- **Wake the chief for both events.** Rejected — review-ready is owner work; the woken chief would only say "the owner must merge," spending strong tokens to relay. The asymmetry is the design.
- **prism `post_finding` / Linear webhook for both.** Rejected for the chief (it isn't reachable via prism — it needs a session wake) and as the primary owner channel (re-introduces the prism coupling this project is built to shed). Allowed only as a future pluggable `Notifier`, never the loop's hard dependency.

## Open questions

- **How the chief learns its own session id to register** — an MCP `register`/`whoami` self-call at chief session start (the chief can call MCP tools), an env var the launcher injects, or the MCP server stamping the session id from request context. Build-time choice; the requirement is "the loop can address the live chief."
- **Stale-registration detection** — rely on `promptAsync` failure as the liveness check, or a `last_seen` heartbeat the chief refreshes? Start with failure-as-signal (simplest); add a heartbeat only if dead-pane pushes prove noisy.
- **Multiple concurrent chiefs** — assumed one at a time (one `chief_registration`). If the fleet ever runs parallel chiefs, the registry becomes a set and the loop routes by feature ownership. Out of scope until it exists.
- **Should a needs-attention push also drop an owner-visible line** for ambient awareness while the chief routes autonomously? Lean yes (console only), so the owner sees the chief was handed work without being asked to act.
