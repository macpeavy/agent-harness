# 0028 — Review-ready also FYIs the chief (at-most-once)

- **Status:** proposed
- **Date:** 2026-06-11
- **Refines:** 0024 (the notify triad's review leg — owner-only there; owner + chief FYI here).

## Context

ADR 0024 made the review transition notify the owner only: merging is owner work, and waking
the strong seat for something it can't route looked like noise. The first multi-chunk run
under that design showed the gap: the chief dispatched a session, told the owner "I'll check
back when the session reaches review", and then sat silent — nothing ever tells the chief a
session finished building. The owner's channels fired (fleet pane, console, tmux), but the
chief is the owner's *conversational interface*; the seat the owner was looking at said
nothing, and its picture of the fleet was stale until the owner prompted it by hand.

The chief now gets woken for needs-attention, CI failures, owner responses, and merges —
build-complete was the one lifecycle event it never heard.

## Decision

When a session enters `review`, the notify pass notifies the owner (unchanged, the stamp's
gating signal) and then sends the chief a one-line FYI wake: the session is built, the PR
number and cost, the owner has been told, nothing to route or close — say one line to the
owner if attended, otherwise just update the picture.

**At-most-once, riding the owner signal's stamp.** The FYI deliberately does NOT get its own
exactly-once column: requiring the chief wake to succeed before stamping would re-ring the
owner's bell every tick while no chief is registered, and a missed FYI is benign — `status`
lists in-review sessions at the top, and a later chief launch reads it there. This is the one
leg of the triad with weaker-than-exactly-once delivery; every routing-relevant signal
(needs-attention, CI, owner response, done) keeps its durable stamp.

## Consequences

- The attended experience matches the chief's own narration: it says the session is ready
  instead of going quiet between dispatch and the owner's next prompt.
- A chief registered after the transition misses the FYI and learns from `status` — accepted.
- Strong-tier cost per FYI is one short prompt; no routing tokens (the prompt says so).
