# 0011 — Execution shape: chief-staged, fleet-dispatched, attended at merge

- **Status:** proposed
- **Date:** 2026-06-07

## Context

The incumbent runs work three ways: an autonomous self-driven loop (`/orchestrate`, build→review→merge with auto-merge inside a safe permission intersection), an attended executor (`/companion`, human present, human merges), and fleet-dispatched sessions (`/fleet`, supervised, build→review→address on a session branch, owner approves the merge from the fleet side — never auto-merges). The vision's parity bar listed all three, weighting the autonomous merge loop. The owner's current direction is explicit: the autonomous `/orchestrate` runs have fallen out of favor; the preferred shape is **fleet + chief-enabled dispatch**. This ADR records the resulting execution model for the port and reconciles it against the vision and ADR 0006.

## Decision

The port's primary execution shape is **chief-staged direction + fleet-dispatched execution, with the human approving the merge.** Concretely:

- **The chief-analogue stages work** — sets direction and decomposes it into chunks (ADR 0010), then dispatches.
- **A fleet-orchestrator-shaped executor runs each dispatch** — build → review → amend (ADR 0008) on a session branch, transitioning to ready-for-review. It is **supervised, not autonomous**: it never auto-merges to main. The human (or an attended session) approves the merge of a strong-reviewed PR.
- **The human sits at two gates** — approving the decomposition (attended planning) and approving the merge. Everything between is cheap build + strong review + amend.
- **The autonomous `/orchestrate` auto-merge loop is de-prioritized** — not deleted from the design space, but not the near-term target. It remains possible only behind the security envelope (ADR 0007), which gates exactly the unattended/auto-merge flip.

This is attended-at-the-merge-boundary. Throughput is not human-bound the way full manual decomposition would be: the expensive cognitive work (decomposition, review) is done by the planner and reviewer; the human's per-PR cost is a merge-approval glance at an already-strong-reviewed PR.

## Consequences

- The executor the port builds is the **fleet-orchestrator shape** (supervised, human-approves-merge), not the autonomous orchestrator. This narrows P3's executor work and matches how the owner wants to run.
- The security envelope (ADR 0007) moves off the near-term critical path: the preferred shape is attended-at-merge, which the envelope does not gate. The envelope still gates any later flip to unattended/auto-merge and any deploy, and the cheap injectable builder handling untrusted repo content still wants the sandbox even when fleet-dispatched — so the envelope is built in parallel, just not blocking.
- The vision's parity bar is re-weighted (this PR updates `vision.md`): the autonomous merge loop drops from a headline parity requirement to a gated, de-prioritized capability; fleet + chief-dispatch becomes the stated shape.
- Human attention is the throughput governor at two well-chosen points, which is also where decomposition quality and merge safety are actually decided — the attended gates are load-bearing, not ceremony.

## Alternatives considered

- **Autonomous `/orchestrate` as the primary mode.** Rejected on owner direction — out of favor, and it front-loads the security envelope as a hard blocker for little near-term benefit.
- **Fully attended (`/companion`) for everything.** Rejected — it human-binds even the merge of routine well-reviewed PRs, throttling the throughput the cost win assumes. The fleet shape keeps the human at the merge gate without making them run every step.
- **Auto-merge on a clean strong review, no human merge gate.** Rejected for the near term — it is the unattended flip the security envelope gates, and the owner wants the merge approval. Revisitable post-envelope if the review gate proves trustworthy under measurement.

## Open questions

- Whether the prism-side dispatch/approval surface the incumbent fleet uses is ported, replaced by GitHub + attach (ADR 0006), or thinned to the registry status read — informed by G6/AGENT-5.
- The exact merge-approval ergonomics: a GitHub approve/merge, a chief-surfaced batch, or an attach-time confirmation — decided with the interaction surface.
- Whether some trivially-safe dispatch classes (one-shot-mergeable utils, by the spike's gradient) earn auto-merge sooner than heavy work — a measurement-gated trust ramp, post-envelope.
