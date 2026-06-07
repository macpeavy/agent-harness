# 0010 — Decomposition-driven planning, the chief-analogue, and the model-tier policy

- **Status:** proposed
- **Date:** 2026-06-07

## Context

The spike's central finding (`docs/spike-results.md`) is that the cheap model's output quality is a function of how well-specified its input is: trivial, tightly-scoped chunks are one-shot-mergeable; heavy, ambiguous chunks are a strong first draft needing review + amend. The strategic consequence is that **the cheap-able fraction — the share of work the cheap tier can carry — is not fixed; it is manufactured by decomposition.** Whatever turns a feature into bite-sized, acceptance-criteria'd chunks is therefore the cost engine of the whole system, not a convenience. That role belongs to a strong-tier planner. In the incumbent design, that planner is the **chief**.

## Decision

**1. The chief-analogue is the chief, ported as it behaves today.** It sets direction (product and technical, fused), writes Linear, composes ADRs, runs the skill audit and composes skills. It is **attended, not autonomous** — it sets direction the owner ratifies; it does not run an unsupervised strategy loop. In the cost architecture, its planning/decomposition output is what manufactures cheap-able work: a feature becomes a DAG of chunks each small and specified enough for the cheap builder to one-shot (or close within the amend cap, ADR 0008).

**2. A good chunk is the unit that makes the cheap tier work.** The planner's decomposition target is a chunk that is: single-surface (one file/component/flow), carries explicit acceptance criteria, names its inputs and data shapes, and is independently buildable. This is the same discipline the incumbent applies to backlog atomicity — re-pointed at a sharper bar, because the executor is a cheap model, not a strong one. Under-decomposition shows up downstream as amend-cap escalations (ADR 0008/0009), which feed back to the planner as a decomposition-quality signal.

**3. Output norm: artifacts over briefs.** The owner reads direction artifacts (ADRs, `roadmap.md`, Linear, `journal.md`, `vision.md`), not long prose briefs. The chief-analogue leads with the artifacts and an executive summary; the long-form brief is retired as a primary output. The `[Brief]` PR remains the ratify-by-merge vehicle for the artifact set.

**4. Per-persona model-tier policy (two tiers to start):**
   - **Cheap tier — the builder** on well-decomposed chunks. A Western tool-calling model (see decision 5).
   - **Strong tier — the chief/planner, the reviewer, amend-escalation builds, and any ambiguous/architectural/novel work.** These either reason at a level the cheap tier can't carry, or are bursty enough that their token cost is small against the build bulk.
   Start two-tier. A middle tier (for heavy-but-patterned builds where a mid model beats cheap+3-amends) is added only if the registry instrument (ADR 0009) shows it pays — measured, not assumed.

**5. The cheap builder is a Western tool-calling model, chosen by probe.** DeepSeek is dropped on data-governance grounds (the owner wants a real alternative, not Chinese-origin weights re-hosted). The hard filter is unchanged and non-negotiable: the model must **tool-call natively through OpenCode + LiteLLM** — the exact capability qwen3-coder lacked and DeepSeek had. Candidates A/B-tested with the spike's existing harness, **Mistral leading** on the data-governance story (EU, strong sovereignty options), with Gemini Flash and Claude Haiku 4.5 as comparators (Haiku a known-good tool-caller but pricier). The pick is whichever clears the tool-calling bar cheapest; pricing is pulled live at probe time, not assumed here.

## Consequences

- The chief-analogue is positioned as the cost engine, which justifies its strong-tier spend: planning is bursty and high-leverage, and every chunk it makes cheap-able multiplies into cheap build tokens.
- The decomposition quality becomes a measurable, improvable property (amend-cap escalation rate), not a vibe — the planner can be tuned against it.
- Two-tier keeps the policy simple and the cost model legible; the instrument tells us if/when a third tier is warranted.
- Dropping DeepSeek re-opens the tool-calling risk the spike closed, so the model probe is a real gate on the build tier — it must land a passing Western model before P2 leans on the cheap builder at volume.
- Retiring the long brief changes the chief-analogue's persona port (output templates, the `[Brief]` PR body) — a concrete spec, not just a preference.

## Alternatives considered

- **A bare planner/decomposer, stripped of direction-setting.** Rejected on owner direction — the chief keeps its full role (direction + Linear + ADRs + skills), attended; it is not reduced to a chunk-splitter.
- **A fully autonomous product-chief.** Rejected — heavier strong-tier spend and the owner wants humans in the direction seat; the chief sets direction the owner ratifies.
- **Keep DeepSeek (re-host on a Western provider).** Rejected per owner — the concern is provenance, not only data residency; a real alternative is wanted even at the cost of re-running the tool-calling probe.
- **One model for all personas.** Abandons the cost lever — the project's whole purpose (ADR 0002, ADR 0005).

## Open questions

- Where the chunk-DAG (feature → chunks, dependencies between chunks) is represented and how the planner emits it to the dispatch loop — decided with the ADR 0009 implementation (likely a sibling planning table).
- How much of the chief's incumbent machinery ports as OpenCode config (ADR 0005) vs. needs substrate support (e.g. the Linear write path, gated on G5/AGENT-2).
- The exact decomposition bar the cheap model needs — calibrated against the first real features under the amend instrument (P4).
- The model probe's outcome: which Western model becomes the builder, and its measured tool-calling reliability and cost.
