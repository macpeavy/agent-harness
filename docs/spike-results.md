# Spike results

Evidence trail for the de-risking spike's gates (G1–G6). Decision rule: `scope/final.md`.

## G1 — fan-out stability (AGENT-6) — PASS · 2026-06-07

5-wide fan-out across 3 distinct LiteLLM routes (builder/qwen3-coder, builder-alt/deepseek-v4-flash, reviewer/sonnet-4.6), driven via the OpenCode session API, 3 rounds. All 15 calls succeeded; in every round `wall ≈ max(task)` — the batch finished in roughly the slowest single task's time, the signature of true concurrency (serialized execution would give `wall ≈ sum`). No errors, no races.

| Round | wall | max task | sum | verdict |
|---|---|---|---|---|
| 1 | 4197ms | 4196ms | 12967ms | concurrent |
| 2 | 3840ms | 3840ms | 10679ms | concurrent |
| 3 | 4435ms | 4435ms | 12413ms | concurrent |

**Key finding:** concurrency holds via the **direct session API** (`POST /session` + synchronous `POST /session/{id}/message`), so the architecture does **not** depend on OpenCode's *experimental* task-tool background-subagent path — the surfaced G1 risk is sidestepped at the substrate layer.

**Harness:** `src/fanout-stress.ts` (`bun run fanout`) + `src/opencode/client.ts` (the substrate's seed OpenCode client). Reproduce: bring up the gateway + `opencode serve`, then `bun run fanout`.

*Note: the first run mislabeled round 3 as serialized — a flawed sum/wall ratio threshold, not a real failure (LLM latency variance pins one task slow under full concurrency). Corrected to the wall≈max signal; data was concurrent throughout.*

## AGENT-7 — dispatch + build leg — WORKS · 2026-06-07

The substrate (`src/dispatch/build-leg.ts`) takes an issue, creates an isolated worktree on a fresh branch off `origin/main`, dispatches the `builder` agent over HTTP (an `opencode serve` bound to the worktree), and — when the builder changes files — commits, pushes, and opens a PR. Verified end-to-end on a real issue (`requireEnv` helper): produced **PR #23** with clean, correctly-typed, scoped, documented code. This also begins **G3** (a cheap model produced mergeable-quality code) and discharges AGENT-4's deferred persona-spawn verification.

**Pivotal model finding (the A/B paid off):** the originally-primary cheap builder, **qwen3-coder-30b, does NOT tool-call** through OpenCode + LiteLLM — it emits tool calls as *text* (`<function=write>…`) that OpenCode never executes, so it cannot edit files. **deepseek-v4-flash tool-calls natively** (runs `pwd`, uses the Write tool, writes the file). It's model-specific, not a stack problem. → The `builder` route was swapped from qwen to **deepseek-v4-flash**; qwen kept as a reference alt with the limitation noted. deepseek is also slightly cheaper on output and carries 1M context; its reasoning-token tax is the price of a model that actually executes tools.

**Follow-up for AGENT-9 (quality):** the worktree has no `node_modules` (fresh checkout), so the builder can't fully typecheck/test its own work in-worktree — it noticed the resulting `process` type error and correctly attributed it to the missing deps. The build leg should `bun install` in the worktree before dispatch so the builder can self-verify. Tracked for the G3 run.

**Mechanism note:** `opencode serve` has no `--dir`; the worktree binding is done via the child's cwd (`src/opencode/serve.ts`). Builder/reviewer agents switched to `mode: all` so the substrate can dispatch them directly (G1 established we drive sessions directly, not via the experimental task tool).

## AGENT-8 — review + wake leg (gate G4) — PASS · 2026-06-07

The substrate dispatches the reviewer (strong route) against a PR over the **token-free wake**: `prompt_async` fires the prompt (HTTP 204), then the substrate polls `/session/{id}/message` until the latest assistant message reports `finish` — *external* idle detection, so no agent burns tokens while idle. Verified against PR #23: idle detected after ~36s, the review captured and posted as a PR comment.

The review itself (sonnet, strong route) was sharp — ranked findings with file:line refs and concrete diffs (JSDoc-vs-`//` convention, missing return-type annotation, no barrel export) and it caught that the `TEST-1` commit references a non-existent backlog ticket. This is the thesis split working: the cheap builder produced clean code (PR #23), the strong reviewer found the real nits.

**Mechanism notes:**
- `POST /api/session/{id}/wait` returns 503 ("V2 session wait is not available yet") — unusable; idle detection is message-polling. `/event` SSE exists as the future cleaner path.
- `prompt_async` returns 204 (fire-and-forget). The client gained `promptAsync` + `waitForReply` (`src/opencode/client.ts`); the leg is `src/dispatch/review-leg.ts`.

With **G1, G3-build, and G4 holding, the dispatch → build → PR → wake → review loop is proven end-to-end.** AGENT-9 formalizes the G3 verdict (mergeability judgment + cost-per-PR).

## AGENT-9 — make-or-break verdict (gate G3) — PASS · 2026-06-07

One real issue (`parseRoutes` util + tests) through the FULL loop — dispatch → build → PR → wake → review — via `src/dispatch/loop.ts`, with `bun install` in the worktree so the builder self-verifies.

**Mergeability ✓** — the deepseek builder produced `src/util/parse-routes.ts` (clean, typed, documented, to spec) **and** `src/util/parse-routes.test.ts` (`bun:test`); the test passes **5/5**. Scoped to those two files. Genuinely mergeable (PR #26).

**Cost ✓** — estimated from real token counts × current OpenRouter pricing:

| leg | route | tokens (in/out) | cost |
|---|---|---|---|
| build | builder (deepseek-v4-flash) | 39,234 / 1,205 | $0.0042 |
| review | reviewer (sonnet-4.6) | 21,255 / 678 | $0.0739 |
| **total** | | | **$0.0781 / PR** |

Target ≤ $2.80/PR (≈ $250 / 90 PRs). Actual **$0.078/PR — ~36× under**, ≈ $7/mo at 90 PRs/mo against the $250 ceiling. Most of the cost is the strong reviewer; the cheap builder is ~$0.004.

---

## Heavy-work cost test — SQLite dispatch registry (REG-1) · 2026-06-07

The earlier G3 runs (#23 requireEnv, #26 parseRoutes) were trivial — a few lines each. They proved the loop and cheap-model-on-toy-work, **not** the reasoning-heavy work that drives real spend. So a deliberately heavier issue was run: a SQLite-backed dispatch registry (`bun:sqlite`, a 5-state machine with validated transitions + transactions, session-id linking, idempotent `resumeIncomplete`, ~8 methods) **plus** its own test suite — PR #28.

**Build (deepseek):** 47,090 in / 5,120 out tokens (4× the util's output — real work). A strong first draft: correct core, transactions on `transition()`, prepared statements, the layering honored (links OpenCode session ids, no duplication), typecheck clean, and a **13-test suite the builder wrote, passing 13/0**. It added WAL mode unprompted — the exact concurrency property that motivated SQLite over JSON.

**Review (sonnet):** 6 ranked findings, including **two High** — a real `setSessions` atomicity gap (two UPDATEs with no wrapping transaction) and the hardcoded non-terminal-state list — plus a missing `close()`, a test-db collision risk, and two test nits. Sharper than the human reviewer's read.

**Cost:** build $0.0057 + review $0.0841 = **$0.090/PR** — ~31× under the $2.80 target, even for a substantial multi-file build.

**The honest read:** the cheap model produces a *strong first draft* of heavy work — correct, tested, typechecked — but **not one-shot-mergeable**, unlike the trivial utils. It needs the strong reviewer + an **amend cycle** to close the real gaps. That makes the review→amend loop (AGENT-8 Option B, deferred) **load-bearing for heavy work, not optional** — and even budgeting 2–3 amend rounds at ~$0.09 each, cost-per-PR stays under ~$0.30, still an order of magnitude under target.

---

## Spike verdict — 2026-06-07 (calibrated; supersedes the earlier "thesis proven" line)

Mechanism and cost are proven; the quality story is honest and conditional.

- **Lock-in escaped** ✓ — the full dispatch → build → PR → token-free-wake → review loop runs on an open stack (OpenCode + LiteLLM + OpenRouter). G1, G2, G4 hold.
- **Cost supported for light *and* heavy work** ✓ — ~$0.08/PR (light) to ~$0.09/PR (a multi-file SQLite state machine), under ~$0.30/PR even with amend rounds, vs the $2.80 budget. The bill is dominated by the strong *reviewer* (~$0.08), not the cheap builder (~$0.005).
- **Quality is conditional** — light work is one-shot-mergeable; heavy work is a strong first draft that **requires the strong reviewer + amend cycle** to reach mergeable. The cheap-build / strong-review / amend architecture is necessary and — the key finding — affordable.

**Limits of the evidence (not yet proven):** one heavy build of a *patterned* task (a CRUD + state-machine class, well-trodden for a coding model). The hardest classes — cross-codebase debugging, architecturally-ambiguous features, novel algorithms — are untested and may need a stronger build tier; chief/ADR-tier reasoning runs the strong model by design (no cheap-build saving there). So: **greenlight the port, with the amend cycle treated as load-bearing and the strong tier reserved for ambiguous/architectural work.** The headline ($250 → ~$7/mo) is directionally real for the build-heavy bulk; the exact blended figure depends on the cheap-able fraction, which the port measures under real load.

Remaining spike items (parallel, non-gating): **G5** (Linear MCP, AGENT-2), **G6** (remote attach, AGENT-5). Security envelope (ADR 0007 / AGENT-11–16) gates unattended operation + deployment.

---

## Builder-model probe — replace DeepSeek with a Western tool-caller (AGENT-17) · 2026-06-07

DeepSeek (and qwen) are China-origin and dropped on data governance (ADR 0010). The replacement must clear the spike's hard filter: **tool-call natively through OpenCode + LiteLLM** — qwen3-coder advertised tool-calling but emitted tool calls as *text* and couldn't edit a file. The screen is empirical: watch the model actually invoke the Write tool and change a file, not trust the model card. Desk research: `research/2026-06-07-builder-model-shortlist.md` (chief discovery workspace).

**Method.** A builder agent pointed at each candidate route, driven through OpenCode by `src/probe-builder.ts`: (1) a single write-a-file task, then (2) a 3-file multi-step build (a util + its test + a marker — the "third tool call" failure mode the research flags for the Mistral lineage). PASS = the files actually land; FAIL = no file (text-emitted call). All routed via **OpenRouter** (the only key configured) — see the caveat below.

**Result — all three candidates tool-call cleanly through the stack** (none text-emit; the qwen failure mode is absent). Cost is the representative multi-step build; baseline DeepSeek ≈ $0.005/build:

| Candidate (via OpenRouter) | Origin | List $/M (in/out) | Single write | 3-file build | ~Cost/build |
|---|---|---|---|---|---|
| **Mistral Small 4** (`mistral-small-2603`) | EU (France) | 0.15 / 0.60 | PASS | PASS | $0.002–0.003 |
| GPT-4.1-nano | US (OpenAI) | 0.10 / 0.40 | PASS | PASS | $0.001–0.002 |
| Gemini 2.5 Flash Lite | US (Google) | 0.10 / 0.40 | PASS | PASS | $0.0016–0.0019 |

**Pick: Mistral Small 4** (`openrouter/mistralai/mistral-small-2603`). It passes both screens, is **EU-governed** (the owner's stated default — state.yml), and its cost lands within a rounding error of the cheaper-per-token US options (its terseness offsets the higher rate). All three sit ~2–3× under the DeepSeek baseline. nano and gemini both passed and are kept as **validated Western alternates** (`builder-nano`, `builder-gemini`) for fallback / re-probe.

**Switched:** `builder` route → Mistral in `config/litellm.yaml` + `opencode.json` (cost table in `dispatch/cost.ts` updated). **DeepSeek and qwen3-coder routes removed on governance grounds** (China-origin; National Intelligence Law).

**Caveat — OpenRouter-only (two diagnostics deferred).** Only `OPENROUTER_API_KEY` is configured, so the protocol's two isolation tests were not run: (1) the GPT-4.1-nano baseline through LiteLLM's *OpenAI provider* (the reference impl) — it ran through OpenRouter's translation instead, a weaker "wiring vs model" baseline; (2) the Gemini **OpenRouter-vs-Google-direct** control — only the OpenRouter half ran, so a future Gemini tool-call drop can't yet be attributed to the translation layer vs the model. Both are revisitable with an OpenAI / Google key (`probe-builder.ts` re-runs them).

**Quality caveat (research / AGENT-17).** Western cheap models trail the Chinese tier by ~20 BFCL points — the governance choice has a real quality cost that likely shows up as **more amend rounds**, not as tool-calling failures. The registry instrument (AGENT-18 / ADR 0009) measures it under real load; the amend cycle (AGENT-20 / ADR 0008) absorbs it.
