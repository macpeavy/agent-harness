# 0025 — Drop Mistral as the cheap builder; gate every builder model before it ships

- **Status:** proposed
- **Date:** 2026-06-09
- **Refines:** 0013 (the model-target map — adds the builder-selection criteria and a mandatory acceptance gate to the "builder = cheap" cell). **Supersedes:** the AGENT-17 builder pick (Mistral Small 4, recorded in `docs/spike-results.md` and ADR 0010 decision 5).

## Context

Mistral Small 4 (`mistralai/mistral-small-2603`, the `builder` route) is a dead end as the cheap builder. The evidence, from the harness-status dogfood on the merged resource-safety branch (AGENT-38):

- Chunk C1 ran **50 LLM turns to the builder route over ~2m40s** and produced **zero tool calls, zero file edits, zero text** — it never attempted to write `src/cli/status.ts` — then froze, and the idle timeout killed it.
- Across **three** dogfood runs Mistral has produced **zero working output**.

This is a **tool-calling/capability failure, not tuning** — the model does not attempt the task. Critically, the harness around it is now sound: in-repo worktrees, idle abort, escalate→park, and session teardown all fired correctly (AGENT-38). The substrate did everything right; the model is the dead end. The AGENT-17 probe that picked Mistral was too weak a screen — it confirmed "tool-calls in a one-off probe" but not "produces a non-empty diff on a real chunk," which is the property that actually matters. Mistral passed the probe and failed reality.

## Decision

**1. Drop Mistral.** Remove `mistralai/mistral-small-2603` from the `builder` route. The route name `builder` is retained; only its upstream changes.

**2. Builder-selection criteria (the bar a cheap builder must clear).**
- **Capability — non-negotiable:** reliably calls tools natively *and* produces a **non-empty diff on a real chunk**. Not "emits tool calls" (qwen failed by text-emitting), not "tool-calls in a probe" (Mistral passed that and still no-op'd) — an actual file change, end to end through the build leg.
- **Governance — non-negotiable:** Western-governed only. Same data-residency reason qwen3-coder and DeepSeek were cut (China-origin; National Intelligence Law). OpenAI / Google / Anthropic (US) qualify; Mistral (EU) qualified on governance and still failed capability — governance is necessary, not sufficient.
- **Cost:** within the thesis (~$0.10–0.35/PR blended). The build leg is the cheapest leg (review + decomposition dominate), so reliability outranks rock-bottom token price — a model that no-ops has infinite effective cost.

**3. The builder-acceptance gate — no model reaches a dogfood untested.** This is the load-bearing decision. Before any model is wired to the `builder` route it must pass a smoke that drives the **real build leg** (`runBuildLeg`, in-repo worktree, idle abort — it depends on AGENT-38) against a **canned trivial chunk that requires a write** (e.g. create `src/_gate/touch.ts` exporting `export const GATE_OK = true`). The gate asserts:

| # | Assertion | Catches |
|---|---|---|
| 1 | **`changed === true`** — a non-empty git diff | the Mistral no-op (`changed:false`) — the primary assertion |
| 2 | the target file exists and typechecks | a malformed / wrong-file write |
| 3 | ≥1 `write`/`edit` tool call in the session (not text-emitted) | the qwen text-emit failure |
| 4 | completed under a tight budget (idle ~60s, cost < $0.10) | empty-loops / hangs (Mistral's 50-turn spin) |
| 5 | scratch worktree + `_gate` file cleaned up afterward | gate residue in the repo |

Green → the model is gate-cleared, recorded with model id + date. Red → rejected; it is **never wired** as the builder. **Policy: the `builder` route may only point at a model with a recorded green gate run.** The swap procedure (below) and the `adding-a-model-route` skill take a green gate as a precondition.

- **Where it lives:** its own command — `make gate-builder ROUTE=builder` wrapping a bun CLI (`src/cli/gate-builder.ts`) that reuses `runBuildLeg` + `OpencodeClient`. **Not** folded into `scripts/verify-gateway.sh` — that is a light routing check (a `curl` chat completion); the gate drives the agentic build loop and inspects the diff, which is a different, heavier thing. `verify-gateway.sh` (route reachable) is a sensible *prerequisite* the gate can call first.

**4. The pick: `google/gemini-2.5-flash-lite`** ($0.10/$0.40 per M, 1M ctx, Google/US). Cheapest Western tool-caller, already a validated alternate (`builder-gemini`). **Gate-contingent** — it ships only on a green `make gate-builder`. Owner's call: lowest cost, leaning hardest on the gate.
- **Honest caveat:** Flash-Lite is the rock-bottom tier — the same tier and the same "passed-a-probe" risk profile Mistral had. The gate proves *not-a-dud* on a trivial chunk; it does **not** prove real-chunk quality at volume. That is the instrument's job (amend rounds / cheap-able fraction, ADR 0009/0014) and the amend cycle absorbs the slack. If Flash-Lite disappoints under load, the route is config-swappable to the documented step-ups: **Gemini 2.5 Flash** ($0.30/$2.50) then **Claude Haiku 4.5** ($1/$5, the known-good tool-caller).

**5. Swap mechanics — config-only, so future swaps are cheap.**
- `config/litellm.yaml`: the `builder` route's `model:` → `openrouter/google/gemini-2.5-flash-lite` (+ comment/pricing). The Mistral entry is removed.
- `opencode.json`: `provider.litellm.models.builder` name/limit is **cosmetic** — it references the route, not the upstream — update the label only.
- `src/dispatch/cost.ts`: the per-route cost constant → the new $0.10/$0.40 rate (the one real code touch; the cost instrument needs the rate).

The route name `builder` never changes, so the agent→route mapping is stable and a swap is one upstream line + a gate run.

## Consequences

- The cheap builder is a current, gate-verified Western tool-caller instead of a model that no-ops. The next dogfood starts from a builder proven to produce a diff.
- The gate turns "throw out Mistral" into "no untested model burns a run again" — a durable guard, not a one-time cleanup. It runs the same code path a dogfood uses, so its pass means what it says.
- A small new surface: `gate-builder` CLI + make target. It reuses the build leg, so it also exercises AGENT-38's resource-safety fixes as a side benefit.
- Cost stays in-thesis at the cheapest tier; the reliability bet rides on the gate plus the instrument-measured swap path, not on hope.
- One-vendor concentration is avoided (builder = Google, reviewer/chief = Anthropic), preserving a fallback if any one upstream regresses.

## Alternatives considered

- **Claude Haiku 4.5 as the default** ($1/$5, known-good tool-caller). Recommended by the chief on reliability-first grounds; **declined by the owner on cost.** Kept as the documented step-up if Flash-Lite fails under load.
- **Gemini 3.5 Flash** — the current *tool-calling leader* (tops the 2026 benchmark), but repriced to $1.50/$9; it's a near-Pro model in the wrong (cheap) seat. Reserved for the strong tier if ever needed.
- **Keep Mistral.** Rejected — three runs, zero output; a capability dead end.
- **Re-host a China-origin model on a Western provider.** Rejected (standing owner call, ADR 0010) — the concern is provenance, not only residency.

## Open questions

- The gate's exact budget thresholds (idle window, cost ceiling) — start at idle ~60s / < $0.10 and tune if false-negatives appear.
- Whether the gate should run on a cadence (pre-dogfood, or CI) in addition to swap-time — start swap-time-mandatory; add a pre-dogfood hook if a model is found to regress between swaps.
- Whether `cost.ts`'s per-route rates should move to config (they're code today) — a separate cleanup; out of scope here.
