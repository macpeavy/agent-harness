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

### Cost of record — the spend ledger (ADR 0026)

LiteLLM computes the real cost of every call. The `litellm_spend_logger.py` callback (wired in
`litellm.yaml` via `litellm_settings.callbacks`) appends each call's real cost + route to a JSONL
ledger at `.substrate/litellm-spend.jsonl` (override with `AH_SPEND_LEDGER`). The substrate reads
it (`src/dispatch/litellm-spend.ts`) and reconciles **real** per-route spend over a time window —
so a feature's recorded cost is real LiteLLM numbers for every leg (build/review/amend) **and**
the chief, not token-count estimation. `make status` shows the per-feature TOTAL with the chief
counted. The ledger is the cost signal for AGENT-9.

### The $25 hard cap

The ledger is logging, **not** a budget gate. Cross-request hard-budget enforcement and the
persistent LiteLLM spend dashboard need a database (`DATABASE_URL`) — and LiteLLM's Prisma store
is Postgres-only (its schema hardcodes `provider = "postgresql"`; SQLite is not an option there).
For the spike we keep it DB-less and enforce the hard ceiling **at the OpenRouter key**: create a
key with a **$25 credit limit** in the OpenRouter dashboard. The runtime budget guard is a later
PR (AGENT-43) on top of the ledger.

### Env

| Var | What |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key (set its credit limit to $25). The gateway's upstream auth. |
| `LITELLM_MASTER_KEY` | The bearer key clients present to the gateway. Any strong secret; never committed. |

## OpenCode — `opencode.json` (AGENT-3, provider wired in AGENT-2/B2)

Defines LiteLLM as a custom `@ai-sdk/openai-compatible` provider (`baseURL` → the gateway),
with per-agent model pins matching the route names above. Built in AGENT-2/AGENT-3.
