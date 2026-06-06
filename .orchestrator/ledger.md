# Orchestrator ledger — agent-harness

Append-only, one short paragraph per significant event. Continuity for later companion/orchestrator sessions.

## 2026-06-06 — dev-companion (spike kickoff)

Took the chief handoff: spike backlog AGENT-1..9, build via attended companion. Environment was bare — no bun/opencode/litellm; `uv` 0.11.16 present, used for the venv (CPython 3.12.13). Researched current models from the live OpenRouter catalog (my training-era picks were stale): builder=`qwen/qwen3-coder-30b-a3b-instruct`, builder-alt=`deepseek/deepseek-v4-flash` (G3 A/B), reviewer=`anthropic/claude-sonnet-4.6`; LiteLLM pinned 1.87.1; $25 cap. **AGENT-1** built inline on branch `agent-1-litellm-gateway`: `config/litellm.yaml` (3 routes), runbook in `config/README.md`, `scripts/verify-gateway.sh`. Hard $25 cap enforced at the OpenRouter key (DB-less gateway for the spike; per-request cost still logged); persistent dashboard deferred to a later DB add. AGENT-1 verified live (all 3 routes return completions; per-request cost present). Finding: `deepseek-v4-flash` is a reasoning model — reasoning-token tax matters for AGENT-9 cost accounting; verify script bumped to max_tokens 256 (PR #11).

## 2026-06-06 — dev-companion (AGENT-3)

Installed `opencode-ai@1.16.2` + `bun@1.3.14` via npm (owner-run; `npm i -g` is outside the allowlist). Wrote `opencode.json`: LiteLLM as `@ai-sdk/openai-compatible` provider (`baseURL` localhost:4000, apiKey via `{env:LITELLM_MASTER_KEY}`), three routes mapped with manual token limits (no auto-detect for custom providers), default model `litellm/builder`. Verified: `opencode run` returned OK on the builder route and the gateway logged `POST /v1/chat/completions 200`; `opencode serve` up, `/doc` returns OpenAPI. **API finding for AGENT-7/8:** the survey's `prompt_async` doesn't exist as named — actual endpoints are `/session/{id}/prompt`, `/session/{id}/wait`, `/session/{id}/children`, and `/experimental/session/{id}/background` (the experimental fan-out for G1). The wake/dispatch driver should target those.

## 2026-06-06 — dev-companion (AGENT-4)

Defined `feature-builder` (→ litellm/builder) and `reviewer` (→ litellm/reviewer) as subagents via the `agent` key in opencode.json, with prompt bodies in `agents/*.md` and safe-intersection permission sets (builder: edit allow + scoped git/gh/bun bash, deny rm-rf/sudo; reviewer: edit deny + read-only git/gh). Confirmed: both load as subagents (`opencode agent list`), config valid, and the permission rules merge into the resolved config (git */gh */bun */rm -rf */sudo */edit all present). **Verification limit (honest):** OpenCode only spawns subagents from a primary (`opencode run --agent <subagent>` falls back to default), so the two live behavioral ACs — per-agent route in gateway logs, and a permission deny actually firing — can't be exercised standalone. They fold into AGENT-6 (fan-out) and AGENT-7 (substrate dispatch), where a primary spawns these subagents for real.
