# 0008 — The amend cycle: build → review → amend → merge, as load-bearing architecture

- **Status:** proposed
- **Date:** 2026-06-07

## Context

The spike's heavy-work test (a SQLite dispatch registry, PR #28) established the quality boundary honestly: the cheap builder produces a *strong first draft* of substantial work — correct core, transactions, a passing 13-test suite, the layering honored — but **not one-shot-mergeable**, unlike trivial utils. The strong reviewer caught two real High findings (a `setSessions` atomicity gap, a hardcoded state list). The conclusion in `docs/spike-results.md`: for anything beyond trivial work, reaching mergeable requires the strong reviewer **plus an amend cycle** where the builder addresses the findings. The review→amend loop is therefore necessary architecture, not an optional add-on. The spike loop (`src/dispatch/loop.ts`) stops at one build + one review and leaves merge to a human judgment call; the port must close that loop.

## Decision

Make **build → review → amend → merge** the standard dispatch lifecycle, with the amend cycle a first-class, bounded loop:

1. **Build** — the cheap builder produces a draft against a chunk's acceptance criteria, self-verifying in-worktree (`bun install` first so it can typecheck/test).
2. **Review** — the strong reviewer returns ranked findings over the token-free wake (the proven AGENT-8 mechanism).
3. **Amend** — if the review raises blocking findings, the substrate dispatches the builder again with the findings as the amend prompt, on the cheap route. Re-review. Repeat.
4. **Merge** — when the review clears (no blocking findings), the dispatch is mergeable. The merge itself stays attended (a human approves a strong-reviewed PR — ADR 0011); the loop's job is to *reach* mergeable.

**The cap and the escalation ladder.** The amend loop is bounded by a cap (default **3 rounds**, configurable). Blowing the cap is treated as a *signal*, not a failure to retry harder: it means the chunk was under-decomposed or is harder than the cheap tier can carry. On cap-exceeded the substrate escalates, in order:
   - **Re-decompose** — hand the chunk back to the planner/chief-analogue to split further (ADR 0010); a chunk that needs >3 amends is usually two chunks.
   - **Promote the build tier** — re-run the build on a stronger model for that chunk (the model-tier policy, ADR 0010).
   - **Hand to attended** — surface to the human/companion when neither lands.

Each amend round, the cap, and any escalation are recorded on the dispatch (ADR 0009) — this is also the instrument that measures decomposition quality.

## Consequences

- Heavy work becomes reliably mergeable on the cheap-build / strong-review split, at a cost that holds: even 2–3 amend rounds at ~$0.09 keep cost-per-PR under ~$0.30, an order of magnitude under the $2.80 budget (spike-measured).
- The cap turns "the cheap model struggled" into actionable signal — re-decompose or promote — instead of an unbounded retry or a silent bad merge.
- Amend-rounds-per-chunk becomes the primary readout of decomposition quality and the cheap-able fraction (ADR 0009, ADR 0010).
- The substrate gains an amend leg (grown from `src/dispatch/review-leg.ts`): findings parsing, the re-dispatch prompt, the cap counter, the escalation switch.
- A blocking-vs-nonblocking finding distinction is needed so cosmetic nits don't burn amend rounds — the reviewer must rank severity (it already does; the substrate must consume it).

## Alternatives considered

- **One build + one review, merge on human judgment** (the spike loop). Fine for trivial work; leaves heavy work stuck at "strong draft, needs changes" with no mechanism to close it. Rejected as the standard lifecycle.
- **Unbounded amend until clean.** Risks an injectable cheap model thrashing, and masks under-decomposition as cost. The cap + escalation is the controlled form.
- **Promote straight to a strong builder on any heavy work.** Forfeits the cost win on exactly the build-heavy bulk the thesis depends on. Promotion is the escalation, not the default.

## Open questions

- The cap default (3) and whether it should vary by chunk size/route — tuned under real load (P4).
- How blocking-vs-nonblocking severity is drawn, and whether nonblocking nits are auto-filed as follow-ups rather than amended in-line.
- Whether re-decompose or tier-promote should be the first escalation rung for a given failure shape — measured, not assumed.
