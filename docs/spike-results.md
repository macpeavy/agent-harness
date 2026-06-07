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
