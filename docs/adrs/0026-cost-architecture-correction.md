# 0026 — Cost architecture correction: the chief is the cost, not the builder

- **Status:** proposed
- **Date:** 2026-06-09
- **Refines:** 0013 (the model-target map / cost split), 0014 (the cost reckoning — *enacts* its rule that decomposition is a large-feature tool, which was written but never implemented), 0009 (the dispatch cost instrument — closes its blind spot). **Builds on:** 0023 (escalate→park — gains a `budget` reason), 0024 (the notification path — carries the budget wake).

## Context

A single day of dogfooding a ~200-LOC PR (a status-viewer CLI) cost **~$15**, and the PR never merged. The breakdown is the lesson:

- The dispatch registry recorded **$10.72** across 12 dispatches: **build $2.40, review $7.72, amend $0.59.** The reviewer (Sonnet) cost **3.2× the builder.**
- The **chief is not in the registry at all** — the dashboard total (~$15) minus the registry (~$11) is ~$4–8 of *uncounted* Sonnet spend (decompose, re-decompose, codebase reads, owner conversation).
- The PR is trivial; the spend came from running the **expensive Sonnet path repeatedly**: four failed attempts × amend rounds × re-decomposes, each re-running the chief decomposition and the Sonnet review.

Three structural facts fall out, and they invert two days of effort spent swapping the *builder* model:

1. **The cost instrument is blind to its most expensive seat.** Every "$/PR" and "cheap-able fraction" number we have was computed from the registry, which excludes the chief. The thesis has been measured with ~half the cost missing.
2. **The cost is Sonnet (reviewer + chief), not the builder.** The builder is the cheapest leg ($2.40, much of it Mistral hang-waste). The reviewer ($7.72) and chief (uncounted) dominate — and they balloon under *re-runs*, because every failed/amended/retried chunk re-pays a Sonnet review.
3. **A small feature is the worst case for decomposition, and we decomposed it anyway — four times.** ADR 0014 already states decomposition only pays by amortization (one understanding pass over many chunks); on a small feature "the decomposition cost wipes the build saving — net loss." The status viewer should have been one cheap build + one review (~$0.20). We ran the large-feature machine on it.

## Decision

Four corrections. None touch the builder — that was never the cost.

**1. The chief is counted.** The cost instrument (ADR 0009) reconciles **per-route spend from LiteLLM** (the system of record for cost) into the registry, so a feature's recorded cost includes chief + reviewer + builder + amends — not just dispatch legs. Until the chief is counted, every $/PR figure is fiction and is labelled as such. This is the precondition for any cost claim about the thesis.

**2. Budget governs by estimate first, and never discards work.** A hard halt is rejected — it throws away tokens already spent building. Instead, two layers:
- **Pre-flight estimate at the decomposition gate.** When the chief presents a plan for approval, it also presents an estimate — chunks × expected build+review + decomposition — as "$X to build this, go?" Overspend is caught *before the first token*, at a gate the owner already stands at.
- **Runtime breach → escalate→park, work preserved.** Because chunks merge into session-main as they land (ADR 0020), completed work is already in the session branch. A budget breach parks the session in `needs-attention` with a new `budget` escalation reason (ADR 0023's machinery) and wakes the owner (ADR 0024) to decide **continue / ship-what's-done / abandon.** Nothing built is lost; the owner never pays for half a feature and gets zero.

**3. Cache the strong (Anthropic) seats at the gateway.** The reviewer and chief re-send a large stable prefix (standards, ADRs, persona, codebase context) on every call. Anthropic prompt caching bills a cached prefix at ~0.1× on reads (5-min TTL, refreshed on hit); the whole chain forwards `cache_control` (Anthropic → OpenRouter → LiteLLM). The levers are both ours:
- **Gateway injection:** configure LiteLLM to inject `cache_control` for the Anthropic routes (`chief`, `reviewer`, `builder-strong`) — a `config/litellm.yaml` change, no OpenCode change.
- **Stable-first context pack:** order the pushed pack (ADR 0018) standards/ADRs/persona *before* the chunk-specific tail, so the cacheable prefix is maximal.
- **Probe before assuming:** fire one review and inspect the usage for `cache_read_input_tokens` to see what OpenCode/LiteLLM already cache. The cheap builder (Gemini/Haiku) is out of scope here — provider-implicit caching, different mechanism.

**4. Decompose only when it amortizes; small features build direct.** This enacts ADR 0014's unimplemented rule. The chief applies a **decompose-vs-build-direct threshold by feature size** (the knob deferred in ADR 0022/0025 for lack of data — this $15 is the data):
- **Small feature → build direct:** no chunk-DAG, no chief decomposition pass. Hand the whole feature to **one builder** (the cheap builder — Haiku — by default; `builder-strong`/Sonnet only if it's genuinely gnarly), with **one review**. The saving is killing the Sonnet decomposition *and* the per-chunk review multiplication.
- **Large feature → decompose** as today (ADR 0014/0020) — the only regime where the chief's understanding pass amortizes.
- "Build direct" means *skip decomposition*, not *use Sonnet to build*. The default direct builder is the cheap seat; strong is the exception.

## Consequences

- $/PR becomes a real number for the first time (the chief counted), so the thesis can finally be measured rather than asserted.
- The dominant cost (Sonnet reviewer + chief) is attacked directly — by caching and by not re-running it on failures and small features — instead of optimizing the cheap builder leg that was never the problem.
- A right-sized small feature like the status viewer drops from ~$10+ to a single build + review (~$0.20–0.50): no decomposition, no re-reviews.
- A budget overrun becomes a *decision*, not a surprise or a discard — caught at the gate by estimate, or parked-with-work-intact at runtime.
- New surfaces: a LiteLLM-reconciliation step in the instrument, an estimate at the decomposition gate, a `budget` escalation reason, gateway cache config, and the chief's size threshold. All modest; none are new subsystems.

## Alternatives considered

- **Hard budget halt.** Rejected (owner) — discards tokens already spent building. Estimate-then-park preserves the work.
- **Demote the reviewer to Haiku.** Rejected — it's the load-bearing safety gate; the asymmetry (strong review over cheap build) is what makes cheap building safe, and the reviewer just proved its worth catching flash-lite's slips. Cache it, don't weaken it.
- **Keep optimizing the builder model.** Rejected — the builder is $2.40 of a $15 day; it was never the cost. Two days on it moved the wrong number.

## Open questions

- The exact decompose-vs-direct size threshold (LOC? file count? the chief's judgment seeded by a default) — start as a chief heuristic, tune against the now-complete instrument.
- Whether the pre-flight estimate is a model call (the chief reasons it) or a deterministic formula (chunks × historical per-leg averages) — favor the formula; it's cheaper and the instrument now has the averages.
- The exact LiteLLM cache-injection config and whether OpenCode already sets breakpoints — resolved by the probe.
