# 0014 — Decomposition: the chief designs, the builder types

- **Status:** proposed
- **Date:** 2026-06-07

## Context

Decomposition is the cost engine (ADR 0010): the cheap-able fraction is manufactured by splitting a feature into chunks small and specified enough for a cheap builder to one-shot, or to close within the amend cap (ADR 0008). This ADR settles *how* decomposition works and, critically, *when it pays* — because a naive "always decompose" pipeline can cost more than it saves.

## Decision

**The reframe.** Decomposition is the chief doing the *design*; the builder does the *typing*. A chunk is "the design, minus the typing." The chief resolves the ambiguity a cheap model can't — interfaces, data shapes, the gotcha decisions — and hands over a near-mechanical chunk. Chunk quality = how much design ambiguity the chief killed before dispatch.

**When to decompose (the cost reckoning).** Decomposition is a *large-feature* tool, not a universal pipeline. Back-of-envelope from spike numbers: cheap build ~$0.005, strong review ~$0.08 (the same either way, so it cancels from the decompose-vs-direct comparison), and a chief decomposition pass ~$0.15–0.20 (Sonnet) / ~$0.80–1.00 (Opus). An Opus chief decomposing a *small* feature into ~5 chunks spends ~$0.20/chunk on decomposition alone — wiping the ~$0.15 build saving. The saving comes from **amortization**: one understanding pass producing *many* chunks. So:
- **Multi-file / multi-surface feature → decompose.** The understanding amortizes; cross-chunk interfaces need pre-deciding.
- **Smaller than that → dispatch direct to a builder**, no decomposition pass.
- **Either way, classify the build tier by complexity** — cheap by default, strong for a complex chunk/feature (the tier hint).
The decompose-vs-direct threshold and the granularity bar are **config parameters** (a harness yaml), tuned empirically against the registry instrument (ADR 0009), not hardcoded.

**Spec to the optimal depth, not maximal.** Under-spec → amend storms (cost up); over-spec → the chief did the builder's job and you paid twice. Resolve the *high-leverage* decisions (interfaces, the atomicity-class gotchas, data shapes); leave the long tail of implementation choices to the builder. The instrument tracks both amend rate (under-spec) and chief-cost-per-chunk (over-spec); the bar is tuned to minimize the **sum**.

**The chunk spec (the unit).** Each chunk carries: *surface* (one file — the natural unit); *intent* (one sentence); *contract* (the exact signatures/types/exports it must produce — load-bearing); *data shapes*; *acceptance criteria* (including a test file — the spike showed the cheap builder writes good tests); *pre-resolved design decisions* (the would-be amends); *dependencies*; *out-of-scope*; *context pack* (the curated subset of repo + coding standards + build skills the builder may read — not the whole codebase); and a *tier hint* (mark a gnarly chunk for strong-build up front).

**Coordination of non-communicating builders: interface-first.** The chief pre-decides every cross-chunk contract, and those interface decisions *are* the coordination protocol — two cheap builders never talk, they build against the chief's shared contract. **Precursors are DAG roots**: a shared type/schema/interface several chunks need is built first, as its own chunk, so consumers don't each invent a conflicting version.

**Granularity and the file boundary.** The natural chunk is **one file** (two builders editing one file in parallel would collide). Parallelism happens *across* files; within a file, work is sequential (the amend cycle). We do **not** split files merely to parallelize — parallelism is a latency win, not a cost win, and the cost win (cheap-per-chunk) holds even for a sequential chain. The granularity bar (target size, single-file) is config, tuned by the instrument.

**The strong builder is a routing choice, not a new persona.** "Strong build" is the builder persona on the strong route. Cheap is the default; a tier-hinted or amend-escalated chunk runs the same builder on the strong model — available from day one at zero extra build cost.

**Where the plan lives.** The chunk-DAG (feature → chunks → dependency edges, holding the chunk specs) lives in a **planning table** sibling to the dispatch registry (ADR 0009): the chief owns the plan, the substrate owns execution, a chunk links to its dispatch row when sent.

## Consequences

- The system spends strong-model tokens only on the *few high-leverage* design decisions per feature; the cheap builder carries the *many low-leverage* implementation decisions, which is most of the tokens.
- The honest blended saving is a **low single-digit multiple**, not the 30× builder-only headline — real on large, build-heavy features with a lean chief, marginal-or-negative on small features with a heavy chief. The port measures it (P4).
- Decomposition quality is measurable (amend-cap escalation rate) and chief over-spec is measurable (chief-cost-per-chunk) — both in the registry instrument, both tuned against.
- Decomposition is a first cut plus reactive re-split: a chunk that blows the amend cap escalates back to the chief to re-split or re-spec (ADR 0008/0013), so the first cut need not be perfect.
- Every chunk's context pack depends on the repo coding standards (AGENT-24) and build-phase skills (AGENT-25) existing — which is why those gate fleet build.

## Alternatives considered

- **Always decompose (a universal pipeline).** Rejected — the cost reckoning shows it loses money on small features. The chief decides per feature.
- **Maximal spec (resolve every decision).** Rejected — the chief becomes the builder and the saving evaporates. Optimal depth, measured.
- **Split files to maximize parallelism.** Rejected — parallelism is latency-only; the cost win doesn't need it, and file-fragmentation harms the codebase.
- **A separate strong-builder persona.** Unnecessary — it is the builder on the strong route, a per-chunk routing choice.

## Open questions

- The planning-table schema (chunk-DAG representation, edge semantics) — designed with the ADR 0009 implementation (AGENT-21).
- The starting values for the decompose-threshold and granularity config knobs — seeded, then tuned by the instrument under real load.
- The exact decomposition bar the cheap builder needs — calibrated against the first real features (P4).
