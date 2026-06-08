# 0020 — Session-main build surface + two-level decomposition

- **Status:** proposed
- **Date:** 2026-06-08
- **Supersedes:** 0011 (the per-PR execution shape). **Refines:** 0008 (the amend cycle gains a second finding source), 0010 / 0014 (the chief now decomposes in two levels), 0013 (the spine adds a session-orchestrator at session granularity).

## Context

The first live chief run shipped one PR per chunk — a pile of unreviewable one-file PRs ("no way I need to review 20 one-file PRs"). The build leg diverged from the pattern the incumbent fleet-orchestrator already established (`~/.claude/agents/fleet-orchestrator.md`): **session-main**, where workers merge into one session branch and the owner reviews a single PR. Porting that pattern — and the two-level decomposition it implies — is this ADR.

## Decision

**1. A session tier above chunks.** A **session** is a meta-decomposed unit of a feature, targeting **~1k LOC** (not counting autogeneration — migrations, lockfiles). Each session gets a `session-main-<id>` branch and **one PR** (`session-main → main`), opened at session start. The owner reviews **one PR per session**, not per chunk.

**2. Two-level decomposition (the chief).** The chief decomposes in two passes: **meta-decompose** a feature into ~1k-LOC sessions, then **decompose** each session into its chunk-DAG (the existing ADR 0014 decomposition). A small feature is one session; a large one is several.

**3. Chunks merge locally into session-main — no per-chunk PRs.** A chunk builds (cheap) → reviews (strong) → amends (ADR 0008); on a clean review it **squash-merges locally into session-main** and the session PR's diff updates. Workers never open PRs.

**4. A session-orchestrator — substrate code, the ADR 0013 spine at session granularity.** It opens the session PR, drives the session's chunk-DAG into session-main, and processes the owner's review. Mechanism (open PR, merge chunks, update the PR, route notes) is **code, no model**; reasoning (decompose, re-decompose on escalation) **escalates to the chief**. There is no strong-model session persona.

**5. Owner review flows through the amend cycle.** The owner reviews the session PR on GitHub and leaves comments / requests changes. The substrate consumes that review as **findings** — the same path as reviewer findings (ADR 0008): a builder amends the relevant chunk, re-merges into session-main, the PR updates. Routine comments are addressed by the loop; only judgment-level comments (re-decompose, design change) escalate to the chief. The owner does **not** hand-relay routine notes through the chief.

**6. The owner's two gates are unchanged in spirit, re-sited.** Approve the decomposition (now: the session plan + its chunk-DAG, conversationally), and approve the merge — now **one session PR**, not N chunk PRs. The merge gate stays the load-bearing safety boundary.

## Consequences

- The review surface collapses from N one-file PRs to ~one PR per ~1k-LOC session — reviewable.
- The amend cycle gains a second finding source (owner PR comments alongside the strong reviewer), reusing existing machinery.
- The plan/registry grows a **session tier** above dispatches (a session owns a set of chunks + a session-main branch + a PR). The build leg changes from "open a PR" to "merge into session-main." The chief persona gains meta-decomposition.
- This is the largest single change since the spine; it touches the build leg, the plan/registry model, the session-orchestrator (new substrate), and the chief persona. Sequence below.
- It re-converges agent-harness with the incumbent fleet-orchestrator's proven shape, rather than inventing one.

## The fixes that ride on this (first-run findings)

Folded into the redesign or sequenced with it:
- **Decomposition rule (refines 0014):** "one file per chunk" → **no two *parallel* chunks touch the same file.** A chunk is one coherent change; a small additive touch to a shared file (a read method) rides with its consumer unless a parallel chunk also touches it (then it's a precursor). Kills the over-fragmentation that forced a one-line `listAllFeatures` into its own chunk.
- **Planning is amendable:** the chief can add/revise chunks (and now sessions) while a feature is in `planning`, until approval — not frozen on create.
- **Completion signal:** the session-orchestrator advances the DAG automatically as chunk deps land, and signals the chief on session completion / escalation, so the chief isn't pull-only and the owner needn't nudge it.
- **Crisp go-detection:** the chief confirms with an explicit echo-and-confirm and treats ambiguous input as not-a-go (it read a stray "1." as approval).

## Alternatives considered

- **Per-chunk PRs (the status quo that failed).** Rejected — unreviewable at any real feature size.
- **A strong-model session-orchestrator persona.** Rejected (ADR 0013) — session-lifecycle bookkeeping is mechanism; it's code, escalating reasoning to the chief.
- **One PR per feature (skip the session tier).** Rejected — a large feature is >1k LOC and still unreviewable as one PR; the ~1k-LOC session is the reviewable unit.

## Sequence

1. **Plan/registry session tier** — a `session` above chunks (session id, branch, PR, its chunks). The first build slice.
2. **Build leg → session-main** — chunks squash-merge into session-main locally; the session-orchestrator opens/updates the one session PR; workers stop opening PRs.
3. **Two-level decomposition in the chief** — meta-decompose into sessions, then the chunk-DAG per session (persona + the `decompose` tool).
4. **Owner-review → amend loop** — the substrate reads the session PR's review and feeds comments into the amend cycle.
5. **The ride-along fixes** — the decomposition-rule refinement, planning-amendable, the completion signal, crisp go-detection.

## Open questions

- How the chief estimates ~1k LOC *before* building, to draw session boundaries — a heuristic, calibrated like the decomposition bar.
- Whether the substrate watches the session PR's GitHub review automatically or the owner triggers "address the review" — start owner-triggered (attended), automate later.
- A session that grows past ~1k LOC mid-build — re-split into two sessions, or accept the overflow for that session.
