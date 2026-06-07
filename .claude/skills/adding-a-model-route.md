---
name: adding-a-model-route
description: Use when adding or changing a model route — a new LiteLLM gateway route and its matching opencode.json model entry. Routing is config, decoupled from the harness.
---

# Adding a model route

**When:** you're wiring a new model into the system — a `chief`/`principal` route, a new
cheap builder (the Western-model probe, AGENT-17), a middle tier. The gateway is the
system of record for routing and cost (ADR 0002); the harness just names a route.

**Files:** `config/litellm.yaml` (the route → upstream mapping) and `opencode.json`
(the matching `models` entry under the `litellm` provider). Keys come from env only.

## How

1. **Add a `model_list` entry in `config/litellm.yaml`**: a `model_name` (the route name
   the harness uses) → an upstream `model:` (e.g. an OpenRouter id) → `api_key:
   os.environ/OPENROUTER_API_KEY`. Comment the seat and rough price, as the existing
   routes do.
2. **Add the matching `models` entry in `opencode.json`** under `provider.litellm.models`,
   with a human `name` and `limit` (`context`, `output`) set manually — OpenCode's
   capability detection misclassifies custom-provider models, so set token limits yourself.
3. **Keep `drop_params: true`** in `litellm_settings` so one client call works across
   qwen/deepseek/anthropic upstreams (some reject params others require).
4. **Verify the route end-to-end** before relying on it: `scripts/verify-gateway.sh`,
   and for a *builder* route confirm it **tool-calls** (the hard filter — qwen emitted
   tool calls as text and was unusable; see ADR 0010 / AGENT-17).
5. **Never commit keys.** The gateway reads `OPENROUTER_API_KEY` / `LITELLM_MASTER_KEY`
   from env; names live in `.env.example`.

## Worked example

`config/litellm.yaml` — the strong reviewer seat:

```yaml
  - model_name: reviewer        # ~$3 / $15 per M tokens
    litellm_params:
      model: openrouter/anthropic/claude-sonnet-4.6
      api_key: os.environ/OPENROUTER_API_KEY
```

`opencode.json` — the matching model:

```json
"reviewer": { "name": "reviewer — claude-sonnet-4.6 (strong)",
              "limit": { "context": 1000000, "output": 64000 } }
```

Adding `principal` (Opus, for the chief A/B): one `model_list` entry on the Opus upstream
+ the matching `opencode.json` model; then point `agents/principal.md`'s entry at it.
