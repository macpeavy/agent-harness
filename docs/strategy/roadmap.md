# agent-harness — port roadmap

*Established 2026-06-07, after the de-risking spike was greenlit (`docs/spike-results.md`). Edited in place as direction shifts — this is the live plan, not a changelog.*

## The thesis the port is built on

The spike proved mechanism and cost; it left the quality story honest and conditional. The synthesis that drives the port:

**The cheap-able fraction is manufactured by decomposition, not found.** A cheap model produces mergeable work when handed extremely well-defined, bite-sized chunks; it produces a strong-first-draft-plus-amend when handed heavy, ambiguous ones. So the architecture is **strong-tier bookends a cheap middle**: a strong planner (the chief) decomposes a feature into tight chunks → cheap builders execute them → a strong reviewer + an amend cycle close the gaps → merge. The strong tier is bursty (plan, review); the cheap tier carries the per-token build bulk. That is where the cost win comes from, and its size is set by how much work the planner can pre-digest into cheap-able chunks — the **cheap-able fraction**, which the port measures under real load.

## The shape, decided

- **Chief-analogue = the chief, ported as it behaves today** — direction (product + technical, fused), Linear writing, ADR composition, skill audit/composition. Attended, not autonomous. In the cost architecture it is the decomposition/planning engine that manufactures cheap-able work (ADR 0010).
- **The chief seat's model is a live A/B, not assumed.** Two identical personas: **`chief` (Sonnet, default)** and **`principal` (Opus, swap-in for parallel testing)**. The chief is the highest-volume strong-reasoning seat and the Max subscription's cheap rate is not reachable through the gateway, so this is the project's central economic question — resolved by lived experience with chief cost instrumented separately, not pre-committed (ADR 0010). The subscription-hybrid (chief on Claude Code, fleet open) is a flagged fallback only if `principal` proves necessary and bare-API Opus blows the budget.
- **Attended planning, fleet-dispatched execution.** The preferred shape is chief-staged direction + fleet-dispatched build/review/amend with the human approving the merge — not the autonomous `/orchestrate` loop, which is de-prioritized (ADR 0011). The human sits at two points: approving the decomposition, and approving the merge of a strong-reviewed PR.
- **Interaction model: the chief drives, its tools are the fleet (ADR 0012).** The owner converses with a persistent chief; the chief decomposes intent and calls substrate `dispatch`/`status` tools (the substrate fans out over the proven direct session API, not OpenCode's experimental task tool). Dispatches are **bounded batches**. Two approval gates, both the owner's: dispatch-approval inline in the conversation, merge-approval on GitHub. Autopilot between the gates. Observation = a thin read-only registry status surface (now in scope — the one place beyond terminal+GitHub) + attach + GitHub.
- **Output norm shifts: artifacts over briefs.** The owner reads direction artifacts (ADRs, this roadmap, Linear, `journal.md`, `vision.md`), not long prose briefs. The `[Brief]` PR is the ratify-by-merge vehicle for artifacts; prose drops to an executive summary. Baked into the chief-analogue port.
- **Cheap builder = a Western tool-calling model**, chosen by probe (DeepSeek dropped on data-governance; Mistral leads). The hard filter is tool-calling through OpenCode + LiteLLM — the thing qwen failed and DeepSeek passed (ADR 0010, model-tier).
- **The dispatcher spine is split by reasoning-content (ADR 0013).** The incumbent runs the whole fleet-orchestrator on opus; we split it: reasoning (decompose, design, escalations) → the chief; coordination (sequence, dispatch, watch, amend loop, lifecycle, merge gate) → substrate **code, no model** (the dispatch loop daemon). The chief hands off and steps back — it does not babysit the loop; it re-engages only on escalation or conversation. Model-target map: **chief/principal = best/strong · loop = no model · builder = cheap (default) / strong (by complexity) · reviewer = strong.** Each tier = how much the role must reason; the spine costs ~nothing, a saving the one-model incumbent couldn't capture.
- **Decomposition pays by amortization, not always (ADR 0014).** The chief does the design, the builder does the typing. Decompose multi-file/surface features; dispatch smaller ones direct; classify build tier by complexity. Spec to optimal depth (high-leverage decisions only — over-spec erases the saving). Honest blended saving: a low single-digit multiple, not the 30× builder-only headline. Granularity + decompose-threshold are config knobs, tuned by the instrument.

## Phases

The phases run partly in parallel. The security envelope (ADR 0007 / AGENT-11–16) is a parallel track that gates only the flip to unattended/auto-merge and deploy — and since the preferred shape is attended-at-merge, it is not on the near-term critical path, but it must close before any autonomous operation or deployment.

### P0 — now, parallel, non-gating
- **G5 — Linear MCP path** (AGENT-2) and **G6 — remote attach** (AGENT-5): companion runs them on say-so. G6 feeds the interaction surface; G5 decides whether the chief-analogue writes Linear or GitHub under the new stack.
- **Cheap-builder model probe** — Western tool-callers (Mistral / Gemini Flash, Haiku as a known-good but pricier reference) through the spike's A/B harness; pick the DeepSeek replacement on evidence.

### P1 — harden the spine (attended)
Grow the spike seeds (`src/dispatch/*`, `src/opencode/*`, ~475 lines of single-purpose scripts) into the real substrate.
- **Dispatch registry** (ADR 0009): `bun:sqlite`, above OpenCode's session store, links session ids, the dispatch state machine, crash recovery, *and* the cheap-able-fraction measurement instrument.
- **The loop as a daemon** — replace the hardcoded one-shot `loop.ts` with a real dispatch loop reading the registry.
- **The amend cycle** (ADR 0008): build → review → amend → merge, with a cap and an escalation ladder. Load-bearing, not optional.

### P2 — the planner / chief-analogue (the cost-unlock, biggest lift)
- Port the chief onto the open stack (ADR 0010): direction + Linear + ADRs + skills, attended; the decomposition engine that turns a feature into a chunk-DAG of cheap-able work. Output norm = artifacts over briefs.
- Per-persona model-tier policy wired (ADR 0010): cheap builder on tight chunks; strong for planner/chief, reviewer, amend-escalation builds, and ambiguous/architectural work.

### P3 — grow the fleet (mostly config)
- Port the rest of the roster as OpenCode configuration (ADR 0005): reviewer variants, QA, producers, and the **fleet-orchestrator** executor shape (supervised, human-approves-merge — ADR 0011). Most personas are config, not code.

### Security envelope — parallel, gates the unattended flip
- AGENT-11 (containerize) → AGENT-13 (egress + gateway-outside) → AGENT-14 (containment); AGENT-15 the gate; AGENT-12 standing; AGENT-10 probe; AGENT-16 brokered web (when the chief-analogue's research context needs it). Must close before any autonomous/auto-merge operation or deploy.

### P4 — measure the cheap-able fraction under real load
- With the spine + planner running on real work, read the registry instrument: amend-rounds-per-chunk, escalation rate, blended cost-per-PR. This produces the *true* blended cost figure and the calibrated thesis verdict the spike deliberately deferred.

## What the port does not chase

- The autonomous `/orchestrate` loop as the primary execution mode (de-prioritized — ADR 0011). It remains possible behind the security envelope; it is not the near-term target.
- A bespoke fleet-manager UI (ADR 0006 stands — GitHub + attach + the registry as a thin status read).
- A blended-cost headline before P4 measures it. The spike's $250→~$7 is directionally real for the build-heavy bulk; the real number waits on the cheap-able fraction.
