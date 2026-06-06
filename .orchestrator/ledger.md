# Orchestrator ledger — agent-harness

Append-only, one short paragraph per significant event. Continuity for later companion/orchestrator sessions.

## 2026-06-06 — dev-companion (spike kickoff)

Took the chief handoff: spike backlog AGENT-1..9, build via attended companion. Environment was bare — no bun/opencode/litellm; `uv` 0.11.16 present, used for the venv (CPython 3.12.13). Researched current models from the live OpenRouter catalog (my training-era picks were stale): builder=`qwen/qwen3-coder-30b-a3b-instruct`, builder-alt=`deepseek/deepseek-v4-flash` (G3 A/B), reviewer=`anthropic/claude-sonnet-4.6`; LiteLLM pinned 1.87.1; $25 cap. **AGENT-1** built inline on branch `agent-1-litellm-gateway`: `config/litellm.yaml` (3 routes), runbook in `config/README.md`, `scripts/verify-gateway.sh`. Hard $25 cap enforced at the OpenRouter key (DB-less gateway for the spike; per-request cost still logged); persistent dashboard deferred to a later DB add.
