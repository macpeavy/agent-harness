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
