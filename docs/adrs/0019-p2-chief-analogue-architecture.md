# 0019 — P2 chief-analogue architecture: the planning context, the chief's tools, the closed escalation loop

- **Status:** proposed
- **Date:** 2026-06-07
- **Builds on:** 0010 (decomposition-driven planning + chief-analogue), 0012 (chief-as-driver interaction model), 0013 (the dispatcher spine + model targets), 0014 (decomposition design), 0017 (substrate module architecture), 0018 (build-context injection).

## Context

The P1 spine is built and shakedown-validated (AGENT-18/19/20/26): a Drizzle-backed dispatch registry, the loop daemon, the amend cycle with a structured verdict and `escalate→park→rewake`. The shakedown proved the cost architecture holds on the Western builder (Mistral), and surfaced the two things the chief must own: pre-resolving design ambiguity (the decomposition bar), and guaranteed context-pack injection (ADR 0018). What's missing is the consumer of all this — the chief-analogue. P2 builds it. This ADR fixes its architecture and scope so the build can start.

## Decision

The chief-analogue is a **strong-route OpenCode agent plus a substrate planning layer.** Three pieces.

**1. A planning context (`substrate/plan/`) — a sibling bounded context to the dispatch registry (ADR 0017).** It holds what the chief authors and the loop reads:
- A **feature** (the owner's intent) → a **chunk-DAG**: chunk rows carrying the spec (surface = one file, contract, data shapes, acceptance, pre-resolved design decisions, tier hint — ADR 0014, shakedown-validated) and dependency edges.
- A chunk becomes a **dispatch** (the existing registry) when its dependencies are satisfied **and** the owner has approved the batch; the dispatch's build-spec column is populated from the chunk spec. Dispatch outcomes (`done` / `escalated`) flow back to the chunk's state in the plan.
This reconciles "the substrate owns the chunk spec" (the dispatch carries it at build time) with "the chief authors it" (in the plan). Layered per ADR 0017 (model / schema / repository), Drizzle per ADR 0016.

**2. The chief agent + substrate MCP tools.** `chief` (Sonnet) and later `principal` (Opus) are OpenCode agents on the strong/best route (the A/B of ADR 0010), reached by the owner per the interaction model (ADR 0012). They call **substrate functions exposed as a local MCP server** — the clean, standard way an OpenCode agent reaches our code (settles ADR 0012's MCP-vs-native open question):
- `decompose(feature)` — the chief reasons out the chunk-DAG and writes it to the plan.
- `dispatch(batch)` — **gated on owner approval**; enqueues ready chunks as dispatches, each with its **chief-curated context pack guaranteed-injected** (standards slice + primary skill, ADR 0018).
- `status()` — reads plan + registry; surfaces progress and **parked escalations**.
The chief does not fan out builds itself (the spike's experimental-task-tool risk); it expresses intent and the substrate executes (ADR 0013). It does not babysit the loop — it hands off and re-engages on escalation or owner conversation.

**3. The escalation loop, closed.** A chunk that blew the amend cap is parked `escalated` (non-terminal). It surfaces in `status`; the chief re-decomposes (splits it in the plan) or tier-promotes (strong-route build), then re-dispatches. This is the consumer the amend cycle has been waiting for.

**The owner sits at two gates** — approve the decomposition (the chunk-DAG, before dispatch), approve the merges (GitHub) — and the chief autopilots between (ADR 0012).

**Scope: core-first.** P2 builds **decompose → curate → dispatch → consume-escalations** only — because that unblocks the one unmeasured number that is the real thesis verdict: the **chief's own decomposition cost on a real multi-file feature** (the shakedown measured only the build loop on hand-written specs). The broader incumbent-chief abilities (memory, stewardship/ADR authoring, tending, producer dispatch, discovery, portfolio) are deferred and tracked under AGENT-27 — the agent-harness chief grows into "behaves as it does today" incrementally; until then the incumbent (Claude Code) chief keeps doing agent-harness's strategy/direction.

## Consequences

- The planning context is the seam between chief (authors the plan) and substrate (executes ready chunks), kept clean as two ADR-0017 contexts rather than overloading the registry.
- The chief reaches the substrate through one well-defined MCP surface (`decompose`/`dispatch`/`status`), not bespoke wiring — and the same surface is what a future autonomous mode would drive.
- Standing up `chief` (Sonnet) first lets real decomposition happen; `principal` (Opus) is added once there's real work to A/B on, so the chief-cost comparison runs against actual features.
- Core-first reaches the thesis verdict (the chief-included blended cost) fastest, at the cost of the broader chief abilities lagging — accepted, and the lag is logged (AGENT-27) so it isn't lost.
- The escalation loop closing makes the whole dispatch → build → review → amend → re-decompose cycle autonomous-capable behind the two human gates.

## Alternatives considered

- **Chunk-DAG in the dispatch registry** rather than a sibling planning context. Rejected — the registry is per-dispatch (execution state); a feature's chunk-DAG with edges is a different altitude. Two contexts (ADR 0017) keep each clean.
- **Bespoke native tools** for the chief instead of a substrate MCP. Rejected — an MCP server is the standard, portable way an OpenCode agent reaches our substrate, and it's the same surface a later autonomous driver uses.
- **Full chief-analogue in P2** (all incumbent abilities at once). Rejected on owner agreement — core-first to reach the chief-cost measurement; broader abilities logged (AGENT-27) and grown incrementally.

## Open questions

- The MCP server's shape and where it runs relative to the chief session (loaded by the chief agent; co-process with the substrate) — settled in the build.
- How a parked escalation re-engages the chief: surfaced in `status` for the owner to route (attended, near-term) vs. the loop directly re-invoking the chief (more autonomous) — start attended.
- The chief's curation rule for the context pack (surface→skills map vs reasoned per chunk, ADR 0018) — decided as the curation is built.
- First measurement target: which real multi-file feature the chief decomposes to produce the chief-included blended-cost number.
