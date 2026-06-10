# agent-harness — port roadmap

*Established 2026-06-07, after the de-risking spike was greenlit (`docs/spike-results.md`). Edited in place as direction shifts — this is the live plan, not a changelog. Last trued up 2026-06-10: P0–P3 are built and shipping; P4 (measurement) is the live phase.*

## The thesis the port is built on

The spike proved mechanism and cost; it left the quality story honest and conditional. The synthesis that drives the port:

**The cheap-able fraction is manufactured by decomposition, not found.** A cheap model produces mergeable work when handed extremely well-defined, bite-sized chunks; it produces a strong-first-draft-plus-amend when handed heavy, ambiguous ones. So the architecture is **strong-tier bookends a cheap middle**: a strong planner (the chief) decomposes a feature into tight chunks → cheap builders execute them → a strong reviewer + an amend cycle close the gaps → merge. The strong tier is bursty (plan, review); the cheap tier carries the per-token build bulk. That is where the cost win comes from, and its size is set by how much work the planner can pre-digest into cheap-able chunks — the **cheap-able fraction**, which the port measures under real load.

## The shape, decided

- **Chief-analogue = the chief, ported as it behaves today** — direction (product + technical, fused), Linear writing, ADR composition, skill audit/composition. Attended, not autonomous. In the cost architecture it is the decomposition/planning engine that manufactures cheap-able work (ADR 0010).
- **The chief seat's model is a live A/B, not assumed.** Two identical personas: **`chief` (Sonnet, default)** and **`principal` (Opus, swap-in for parallel testing)**. The chief is the highest-volume strong-reasoning seat and the Max subscription's cheap rate is not reachable through the gateway, so this is the project's central economic question — resolved by lived experience with chief cost instrumented separately, not pre-committed (ADR 0010). The subscription-hybrid (chief on Claude Code, fleet open) is a flagged fallback only if `principal` proves necessary and bare-API Opus blows the budget.
- **Attended planning, fleet-dispatched execution.** The preferred shape is chief-staged direction + fleet-dispatched build/review/amend with the human approving the merge — not the autonomous `/orchestrate` loop, which is de-prioritized (ADR 0011). The human sits at two points: approving the decomposition, and approving the merge of a strong-reviewed PR.
- **Interaction model: the chief drives, its tools are the fleet (ADR 0012).** The owner converses with a persistent chief; the chief decomposes intent and calls substrate `dispatch`/`status` tools (the substrate fans out over the proven direct session API, not OpenCode's experimental task tool). Dispatches are **bounded batches**. Two approval gates, both the owner's: dispatch-approval inline in the conversation, merge-approval on GitHub. Autopilot between the gates. Observation = a thin read-only registry status surface (now in scope — the one place beyond terminal+GitHub) + attach + GitHub.
- **Output norm shifts: artifacts over briefs.** The owner reads direction artifacts (ADRs, this roadmap, Linear, `journal.md`, `vision.md`), not long prose briefs. The `[Brief]` PR is the ratify-by-merge vehicle for artifacts; prose drops to an executive summary. Baked into the chief-analogue port.
- **Cheap builder = Claude Haiku 4.5, behind the builder-acceptance gate — settled (ADR 0025).** The probe ran its course: Mistral shipped and was reversed on correctness slips; gemini-2.5-flash-lite failed in dogfood; Haiku cleared the gate. The durable mechanism is the gate itself — any future candidate is one cheap gated trial away, so the seat stays swappable without re-litigating. The original hard filter (tool-calling through OpenCode + LiteLLM) stands.
- **The cost lives in the strong seats, not the builder (ADR 0026).** Dogfooding showed chief + reviewer (Sonnet) dominate spend; the builder leg was never the problem. All four corrections are landed: the chief is counted (LiteLLM reconciliation into the instrument), small features build direct (no decomposition), the strong seats are prompt-cached at the gateway, and budget governs by estimate-at-gate + escalate→park. **Every $/PR figure recorded before 2026-06-09 is unreliable** — the chief was uncounted and the reviewer was mis-pinned to Haiku until PR #134. The first trustworthy data point: ~$3 for a ~900-LOC feature (feature-history, #137), fully counted.
- **The dispatcher spine is split by reasoning-content (ADR 0013).** The incumbent runs the whole fleet-orchestrator on opus; we split it: reasoning (decompose, design, escalations) → the chief; coordination (sequence, dispatch, watch, amend loop, lifecycle, merge gate) → substrate **code, no model** (the dispatch loop daemon). The chief hands off and steps back — it does not babysit the loop; it re-engages only on escalation or conversation. Model-target map: **chief/principal = best/strong · loop = no model · builder = cheap (default) / strong (by complexity) · reviewer = strong.** Each tier = how much the role must reason; the spine costs ~nothing, a saving the one-model incumbent couldn't capture.
- **Decomposition pays by amortization, not always (ADR 0014).** The chief does the design, the builder does the typing. Decompose multi-file/surface features; dispatch smaller ones direct; classify build tier by complexity. Spec to optimal depth (high-leverage decisions only — over-spec erases the saving). Honest blended saving: a low single-digit multiple, not the 30× builder-only headline. Granularity + decompose-threshold are config knobs, tuned by the instrument.

## Phases

The phases run partly in parallel. The security envelope (ADR 0007 / AGENT-11–16) is a parallel track that gates only the flip to unattended/auto-merge and deploy — and since the preferred shape is attended-at-merge, it is not on the near-term critical path, but it must close before any autonomous operation or deployment.

### P0 — done (probe) / deferred (G5, G6)
- **Cheap-builder probe: closed by ADR 0025** (Mistral → flash-lite → Haiku 4.5, gate-cleared).
- **G5 — Linear MCP path** (AGENT-2) and **G6 — remote attach** (AGENT-5): never run; explicitly deferred. G5's trigger is the ported chief taking on Linear tending (the chief-ability track); G6's is the interaction surface needing more than tmux attach. Neither blocks P4.

### P1 — done (shipped 2026-06-07)
The spine is real: dispatch registry on Drizzle (ADRs 0009/0016), the dispatch loop as a daemon, the amend cycle with cap + escalate→park (ADRs 0008/0023). Hardened 06-08/06-09: session-main build surface + two-level decomposition (ADR 0020), granularity-as-config (ADR 0022), resource-safety + status-driven wait.

### P2 — done (shipped 2026-06-08/09)
The chief-analogue is ported and driving: decomposition into the chunk-DAG, conversational dispatch gate with pre-flight budget estimate, build-direct for small features (ADR 0026), per-persona model-tier policy wired. The chief seat A/B (Sonnet `chief` / Opus `principal`) remains live and is now P4's most consequential measurement — ADR 0026 made the chief the dominant cost seat.

### P3 — done (shipped 2026-06-09)
The fleet shape runs end-to-end: three features built and merged by the harness itself (fleet-status #117, budget-v2 #133, feature-history #137), human at the merge gate throughout.

### Security envelope — parallel, gates the unattended flip (unchanged)
- AGENT-11 (containerize) → AGENT-13 (egress + gateway-outside) → AGENT-14 (containment); AGENT-15 the gate; AGENT-12 standing; AGENT-10 probe; AGENT-16 brokered web (when the chief-analogue's research context needs it). Must close before any autonomous/auto-merge operation or deploy.

### P4 — **live now**: measure the cheap-able fraction under real load
The instrument is finally trustworthy (chief counted, reviewer pinned, caching on, budget guarded). What the verdict needs:
- **N ≥ 3–5 clean dogfood features**, including at least one stateful, write-path, multi-surface feature — the feature-history run (cheap-able 1.00, zero escalations) was read-path-only, the friendliest terrain; the fraction stays flattered until harder work tests it.
- **One strong-direct baseline**: the same class of feature built Sonnet-end-to-end, for the yardstick. Without it the ~$3 figure has no denominator. Expectation of record (ADR 0014): a low-single-digit saving, not a 30× headline.
- **The chief-seat A/B instrumented**: chief-seat $/feature by model (Sonnet vs Opus), now that the chief is the dominant cost.
- Read the registry: amend-rounds-per-chunk, escalation rate, blended $/PR — the calibrated thesis verdict the spike deferred.

**Functional gap before measurement runs clean: the notification subsystem** (AGENT-37 + AGENT-45 + AGENT-44 — push the chief on needs-attention, detect merges, driver liveness). Until it lands the loop is supervised, not self-closing.

## What the port does not chase

- The autonomous `/orchestrate` loop as the primary execution mode (de-prioritized — ADR 0011). It remains possible behind the security envelope; it is not the near-term target.
- A bespoke fleet-manager UI (ADR 0006 stands — GitHub + attach + the registry as a thin status read).
- A blended-cost headline before P4 measures it. The spike's $250→~$7 is directionally real for the build-heavy bulk; the real number waits on the cheap-able fraction — and on the strong-direct baseline that gives it a denominator.
- Further builder-model optimization. The builder is the cheapest leg and a flakier one multiplies strong-tier reviews (every amend round re-pays a Sonnet review). The acceptance gate stays as standing infrastructure for re-testing candidates as the market moves; the seat is not an active workstream.
