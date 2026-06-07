# 0013 — The dispatcher spine: split by reasoning-content; the model-target map

- **Status:** proposed
- **Date:** 2026-06-07

## Context

"What is the spine that plans and dispatches builders?" The incumbent answer is the **fleet-orchestrator** (`~/.claude/agents/fleet-orchestrator.md`): a principal-tier coordinator running on **opus** that consumes a one-line intent, decomposes it, dispatches feature-builders, runs the build → review → address chain, drives a session-lifecycle state machine on a cron tick, parks/wakes, and merges on owner approval. It is the spine — and it runs *entirely on one strong model* because the incumbent has no per-persona routing.

That persona fuses two different kinds of work onto one expensive model:
1. **Reasoning** — form a view on the intent, decompose, sub-decompose when a build returns larger than implied, the Tier-3 ADR-consistency check, blast-radius judgment.
2. **Mechanism** — the per-tick state machine, sequencing, dispatching, collecting returns, the amend loop, parking/waking, the merge gate. The bulk of the persona, and almost none of it is reasoning — it is a deterministic procedure.

The incumbent pays opus for both because it cannot route. agent-harness can. This ADR settles how the spine is structured and the model tier of every role — the "natural argument for model targets."

## Decision

**Split the spine by reasoning-content.**

- **Reasoning → the chief (`chief`/`principal`, ADR 0010).** Decomposition, interface/design decisions, sub-decompose-on-escalation, the ADR-consistency and blast-radius judgment. The strong/best seat.
- **Mechanism → the substrate dispatch loop (ADR 0003/0009), as code, no model.** Sequencing the chunk-DAG, dispatching builders, collecting returns, running the amend loop (ADR 0008), the lifecycle state machine, parking/waking, the merge gate. This is the AGENT-19 loop daemon — deterministic, testable, modelless.

**The chief hands off and steps back; it does not babysit the loop.** The chief produces the approved plan, hands it to the loop, and disengages. The loop runs autonomously on code; status surfaces via the dashboard (reads the registry); PRs land for the owner's merge-approval. The chief re-engages — spending strong tokens — only when the loop **escalates** (a chunk blows the amend cap → re-decompose, ADR 0008) or the owner converses with it. Running coordination on a strong model — what the incumbent does on every cron tick — is the same waste as an over-used strong chief, one layer down, and we refuse it.

**Borderline judgment in the loop escalates up to the chief; it does not run a model in the loop.** The loop's few genuinely-judgmental moments (e.g. "is this over-sized build splittable") are escalated to the chief rather than handled by a model embedded in the coordinator. A cheap in-loop classifier is added only if measurement shows the chief is being woken too often for trivia — measured, not assumed.

**The model-target map:**

| Role | What it does | Tier |
|---|---|---|
| **chief / principal** | plan, decompose, design interfaces, handle escalations, direction | best / strong (Sonnet default, Opus A/B — ADR 0010) |
| **dispatch loop (the spine)** | sequence, dispatch, watch, amend loop, lifecycle, merge gate | **no model — code** |
| **builder** | build one chunk | cheap (default) / strong (by chunk complexity — the tier hint) |
| **reviewer** | review a diff | strong |

Each role's tier equals how much it must *reason*. The load-bearing consequence: the dispatcher spine, which the incumbent runs on opus, costs us essentially nothing.

## Consequences

- The dispatcher spine is ~free (deterministic code), a saving the one-model incumbent structurally could not capture. Strong-model tokens are spent only where reasoning actually happens — decomposition, escalation, review.
- This refines ADR 0012's "the chief drives": the chief drives by *planning and handing off*, not by sitting in the tick loop. "Its tools are the fleet" means it initiates and owns the plan; the loop executes it without further strong-model involvement until an escalation.
- The coordinator being code makes it deterministic and unit-testable — the lifecycle state machine, the amend-cap logic, the merge gate are all covered by tests rather than living in a model's behavior.
- It composes with the cost reckoning (ADR 0014): the system spends strong tokens only on the irreducible reasoning, so the blended cost is dominated by decomposition + review, both bursty.
- A clean escalation interface (loop → chief) becomes a load-bearing seam: the loop must be able to call up to the chief with a re-decompose request and consume the chief's revised chunk(s).

## Alternatives considered

- **A monolithic strong coordinator** (port the fleet-orchestrator as-is, on a strong route). Rejected — it pays a strong model for cron-tick bookkeeping, the exact waste per-persona routing exists to remove.
- **A cheap model running the coordinator loop.** Rejected as the default — the deterministic core needs no model at all; a model in the loop adds cost and nondeterminism. Reserved as a measured option only if escalation-to-chief proves too chatty.
- **The chief in the loop (babysitting each tick).** Rejected — burns strong tokens on watching; the chief plans and steps back.

## Open questions

- The exact escalation interface between the loop and the chief (the re-decompose call/response shape) — designed with the planning table (ADR 0014 / AGENT-21).
- Whether any in-loop judgment is frequent enough to justify a cheap classifier rather than a chief escalation — measured under load (P4).
- How owner conversation with the chief interleaves with a running loop (the chief is "on call" for reasoning and dialogue while the loop runs) — refined with the interaction surface (ADR 0012 / the dashboard).
