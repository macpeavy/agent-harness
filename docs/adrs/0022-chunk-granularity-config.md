# 0022 — Chunk granularity is config, not prose

- **Status:** proposed
- **Date:** 2026-06-08
- **Refines:** 0014 (specifies the config surface 0014 deferred), 0020 (formalizes the decomposition rule the chief persona already holds).

## Context

ADR 0014 said the granularity bar "is config, tuned by the instrument" — but the config was never built. What shipped instead was prose: `docs/standards.md` carries a rigid *"One file per chunk… if it sprawls, it's more than one chunk,"* frozen at the smallest possible chunk size and written as law.

That prose is the root of two live problems:

1. **The chief waffles.** `agents/chief.md` and ADR 0020 both already carry the refined rule (the real invariant is *no two parallel chunks touch the same file*; a one-liner rides with its consumer). But `standards.md` ships in the chief's context pack, and the stale line contradicts the persona — so on a real decomposition the chief oscillates, citing "the standard: one file per chunk" against its own correct instinct, and fragments one-liners into their own chunks. ADR 0020 named the exact symptom (a one-line `listAllFeatures` forced into its own chunk) but the fix never reached `standards.md`.

2. **The promised knob doesn't exist.** The cost thesis depends on tuning chunk size against the instrument (bigger chunks = less chief overhead, more amends; smaller = the inverse; minimize the sum). A prose rule can't be A/B-tuned.

The deeper error: *"one file per chunk" encoded a dial as a rule.* Chunk size is an empirical dial the instrument is meant to optimize; freezing it at "one file" and writing it as prose made it both un-tunable and a thing the chief argues with.

## Decision

Granularity splits into two bins, and **only one is config.**

**Invariants — always true, live in the persona (`agents/chief.md`), never config:**
- *No two parallel chunks touch the same file.* A correctness invariant (two cheap builders editing one file collide), not a preference — never a knob.
- A small additive touch to a shared file rides with its consumer; a shared surface several chunks need is a precursor (its own chunk, built first); interface-first. These are judgments, not numbers.

**Dials — empirical, tuned by the instrument, live in `config/decomposition.yaml`:**
- **`chunkTargetLines`** — the soft size the chief aims a chunk at. A lean, not a hard cap; the chief uses judgment, the number is the default it gravitates to.
- **`sessionTargetLines`** — the same dial one tier up (the reviewable-PR-size target from ADR 0020, ~1k LOC).

LOC is a crude proxy, but it is what the instrument measures for free; both values are soft targets the chief reads into its decompose reasoning, not validators that gate a build.

**The single-source rule:** `docs/standards.md` and `agents/chief.md` **reference** the config dials and the invariants; they never restate a granularity *number*. Each fact lives in exactly one place, so it cannot re-drift. The stale `standards.md` "one file per chunk" prose is deleted and replaced with a pointer to the invariant + the config surface.

Decompose-vs-build-direct (the threshold below which a feature skips the design pass) is **not** a dial yet — there is no instrument data to tune it against, so it stays a persona heuristic until there is. A knob nobody can calibrate is a fancier hardcode.

## Consequences

- The waffle ends: the chief reads one authoritative rule, not two contradictory ones.
- The granularity dials become real and tunable — the instrument can sweep `chunkTargetLines` / `sessionTargetLines` and the measurement thesis (ADR 0014) gets the surface it always needed.
- A new config surface (`config/decomposition.yaml`) and its loader; the chief's decompose context pack gains the two values; `standards.md` and the persona lose their granularity numbers and gain pointers.
- The invariant/dial discipline is now explicit and reusable: future granularity questions get sorted into "is this a correctness rule or an empirical dial?" before anyone writes prose.

## Alternatives considered

- **Make "one file per chunk" itself a config flag.** Rejected — repeats the category error. The collision rule is an invariant; turning it into a knob invites breaking merges.
- **Just fix the prose, no config.** Rejected — fixes the waffle but not the unbuilt promise; the size dials stay un-tunable and the instrument can't do its job.
- **More dials now (maxFiles, decompose-vs-direct).** Rejected — "max files" is the collision *invariant*, not a number; decompose-vs-direct has no calibration data. Ship the two dials the chief uses every decomposition; add others when the instrument can tune them.

## Open questions

- The starting values for `chunkTargetLines` / `sessionTargetLines` — seeded as guessed defaults (`sessionTargetLines` ≈ 1000 per ADR 0020; `chunkTargetLines` a soft ~200–300), then tuned by the instrument's amend-rate-vs-chief-cost signal.
- Whether `config/decomposition.yaml` stays standalone or later folds into a broader substrate config file as more dials appear.
