# 0027 — Amend-round escalations are routable: the chunk follows its dispatch

- **Status:** proposed
- **Date:** 2026-06-11
- **Refines:** 0020 (slice 4b, the owner-review → amend loop), 0023 (the chief-vocabulary rule — "a parked chunk is never outside the chief's reach" — extended to amend-round parks).

## Context

The first build-direct run (PR #151, GH #155 / AGENT-55) hit a dead end the state model
allowed: the owner requested changes, `address_review` reopened the landed chunk's dispatch
(`done → amending`), the amend round failed, and `escalateOrFail` parked the **dispatch**
(`escalated: attended`) — but the **chunk** stayed at `done` from its original successful
build, because `recordOutcomes` only flows outcomes onto `dispatched` chunks and the chunk
graph had no edge out of `done`. The chief's routing verbs validate **chunk** state, so both
threw: `promote()` and `redecompose()` rejected with `chunk … is not escalated (state: done)`.
The escalation was unroutable, the PR silently never updated, and the misleading error fed
the chief's false success report (AGENT-56).

Two aggravating gaps rode along:

- `escalation_reason` was null — `owner-note` (and `no-op`, `amend-cap`) carried no message,
  so the chief routed blind and invented taxonomy ("attended means the amend hit the cap" —
  wrong; amend-cap maps to `re-decompose`).
- A promote-as-rebuild would not have worked anyway: the chunk's content is already in
  session-main, so a fresh strong-tier rebuild of the original contract produces an empty
  diff and re-parks as `no-op`. What the escalation actually needs is a **strong-tier amend**
  against the findings the cheap amend failed on.

## Decision

**One source of truth: chunk state mirrors the dispatch escalation at the plan layer.**
The dispatch registry stays the record of what happened to the build; the plan's chunk state
stays the routing surface. When an amend round escalates a dispatch whose chunk already
landed, `recordOutcomes` flows the escalation onto the chunk — never the reverse, and the
routing verbs keep validating chunk state unchanged.

Three new edges, mirroring the existing reopen edge (`done → amending`) on the dispatch graph:

| Graph | New edge | Meaning |
|---|---|---|
| chunk | `done → escalated` | an owner-review amend round escalated; the chunk follows its dispatch |
| session | `review → needs-attention` | the in-`review` amend loop parked; surface the stuck session (the notify pass wakes the chief, ADR 0024) |
| dispatch | `escalated → amending` | promote on an amend escalation **resumes the amend** on the same dispatch/branch instead of rebuilding |

**Promote on an amend escalation is an amend-resume, not a rebuild.** A failed owner-amend
keeps `pendingFindings` on the row (it was previously cleared unconditionally). `promote`
detects the kept findings on the parked dispatch and, instead of materialising a fresh
dispatch, moves the same dispatch `escalated → amending` with `tier: strong`; the daemon's
existing pendingFindings path re-runs the amend on the strong builder (the amend leg is now
tier-aware) and the fix re-merges into session-main through the normal review cycle.
`redecompose` is unchanged — retiring a landed chunk remains the chief's judgment call.

**Every parked reason is recorded.** `classifyFailure` gives the modes without a
caller-supplied message (`no-op`, `amend-cap`, `owner-note`) a default one, so
`escalation_reason` is never null and `status` always shows the recorded cause.

## Consequences

- An amend-round failure now lands in the standard needs-attention flow: chunk `escalated`
  with a reason, session `needs-attention`, chief woken once (signaled_at), `promote` /
  `redecompose` both legal. The session returns through `building → review` as the resumed
  amend lands, re-arming the owner's review-ready signal.
- A known residual: if the owner-amend itself succeeds but the **re-review** then exhausts the
  amend cap, the findings were already cleared, so promote on that park falls back to the
  fresh-rebuild path (which may no-op-park on an already-landed chunk). `redecompose` covers
  it. Persisting the last blocking review on every escalation is a possible refinement; not
  taken here to keep the in-cycle (in-memory) findings path unchanged.
- `done` is no longer terminal for chunks; `isChunkTerminal("done")` is now false. The only
  consumer deriving terminality from the graph is the abandon/reap path, which force-
  transitions regardless.
