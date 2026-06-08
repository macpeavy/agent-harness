# config — gateway + harness configuration

Configuration for the infrastructure processes. **No secrets ever** — credentials come from the environment (`.env`, see `.env.example`).

## LiteLLM gateway — `litellm.yaml` (AGENT-1)

The model spine. Routes via OpenRouter (the live set; see `litellm.yaml` for pricing notes):

| Route name | Model | Seat |
|---|---|---|
| `builder` | `mistralai/mistral-small-2603` | cheap builder (primary, EU-governed; AGENT-17) |
| `builder-nano` | `openai/gpt-4.1-nano` | cheap builder (validated Western alternate) |
| `builder-gemini` | `google/gemini-2.5-flash-lite` | cheap builder (validated Western alternate) |
| `reviewer` | `anthropic/claude-sonnet-4.6` | strong reviewer |
| `chief` | `anthropic/claude-sonnet-4.6` | strong — the decomposition / cost engine (ADR 0019) |

(The original `qwen`/`deepseek` cheap routes were removed on data-governance grounds — China-origin, National Intelligence Law; see `litellm.yaml`.)

### Run it

```bash
# one-time: create the venv + install (uv)
uv venv
uv pip install 'litellm[proxy]==1.87.1'

# each run: provide credentials and start
source .venv/bin/activate
set -a; source .env; set +a          # exports OPENROUTER_API_KEY, LITELLM_MASTER_KEY
litellm --config config/litellm.yaml # → http://localhost:4000
```

Or just `make gateway` (and `make up` for the whole session — gateway + daemon + chief in one tmux). See the root `Makefile`.

### Verify

```bash
set -a; source .env; set +a
./scripts/verify-gateway.sh           # health + a completion on each route
```

### The $25 hard cap

Cross-request budget enforcement and the persistent spend dashboard need a database
(`DATABASE_URL`, Postgres). For the spike we keep it DB-less and enforce the hard
ceiling **at the OpenRouter key**: create a key with a **$25 credit limit** in the
OpenRouter dashboard. LiteLLM still logs per-request cost (the AGENT-9 cost signal);
add the DB later if we want the LiteLLM UI.

### Env

| Var | What |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key (set its credit limit to $25). The gateway's upstream auth. |
| `LITELLM_MASTER_KEY` | The bearer key clients present to the gateway. Any strong secret; never committed. |

## OpenCode — `opencode.json` (AGENT-3, provider wired in AGENT-2/B2)

Defines LiteLLM as a custom `@ai-sdk/openai-compatible` provider (`baseURL` → the gateway),
with per-agent model pins matching the route names above. Built in AGENT-2/AGENT-3.
