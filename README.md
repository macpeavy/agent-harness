# agent-harness

An open, self-hosted runtime for an autonomous multi-agent software-engineering fleet. A fleet of role-specialized agent personas takes work from an issue tracker and a direction layer, builds it on isolated branches, reviews it, and merges it — running on an open harness with per-persona model routing through a self-hosted gateway.

The agent design is the asset; the harness underneath is a commodity. agent-harness exists to free that design from a single-vendor runtime and to make the cost of running it both controllable and observable.

See [`docs/strategy/vision.md`](docs/strategy/vision.md) for the full vision and non-goals.

## Architecture

Three processes on the box, plus plugins inside the harness:

```
LiteLLM gateway (:4000) ──→ OpenRouter / upstreams
   per-persona routing · hard budgets · cost dashboard
        ▲ OpenAI-compatible HTTP (opencode.json points here)
OpenCode server (`opencode serve`) ── THE HARNESS
   agent loop · tool exec · sessions (SQLite) · REST API + OpenAPI (/doc)
   loads: agents (md) · commands (md) · plugins (TS, in-process)
        ▲ typed HTTP client (from /doc)  +  SQLite reads
Substrate (TypeScript / Bun) ── OURS
   dispatch · watcher · wake driver (POST /session/:id/prompt_async)
   gh/git · merge gate · lifecycle
```

OpenCode is a **client-server application**, not an embedded SDK: `opencode serve` is the engine, and the operator's TUI and our substrate are both clients of it. A persona is a *configuration* of OpenCode (an agent definition + a model route + a permission set), not code we write. See [`docs/adrs/`](docs/adrs/) for the foundational decisions.

## Status

De-risking **spike** in progress — proving the cost + lock-in thesis before the full re-platform. Backlog and build order live in the `agent-harness` Linear team (`spike` label), mirrored to GitHub issues. The spike's scope, success gates (G1–G6), and decision rule are tracked alongside the work.

## Layout

| Path | What |
|---|---|
| `docs/strategy/` | Vision, direction. |
| `docs/adrs/` | Architecture Decision Records (foundational set is `proposed`). |
| `config/` | LiteLLM + OpenCode configuration (built in AGENT-1 / AGENT-3). |
| `agents/` | OpenCode persona definitions (built in AGENT-3). |
| `src/` | The TypeScript substrate (built in AGENT-7 / AGENT-8). |

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- [OpenCode](https://opencode.ai)
- A running [LiteLLM](https://litellm.ai) gateway

Copy `.env.example` to `.env` and fill in credentials. Never commit `.env`.

## Portability

Primary target is a headless Linux server, driven over SSH. Must also run on macOS. The whole stack (OpenCode, LiteLLM, Bun) supports both; macOS is validated as a post-spike checklist item.
