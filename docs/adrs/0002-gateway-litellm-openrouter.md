# 0002 — Model gateway: self-hosted LiteLLM with OpenRouter upstream

- **Status:** proposed
- **Date:** 2026-06-06

## Context

The cost goal — comparable output to a premium subscription-month at roughly $250/month of metered spend — depends on routing each persona to an appropriately-priced model and on being able to *see* and *cap* spend. The harness itself cannot provide this: OpenCode reports $0 cost for custom-provider calls, so cost observability has to live elsewhere. We need a seam that presents an OpenAI-compatible interface to the harness, routes to arbitrary upstream models, enforces hard budgets, and exposes a spend dashboard.

## Decision

Run a **self-hosted LiteLLM** gateway as the model spine. OpenCode points its provider at LiteLLM via an `@ai-sdk/openai-compatible` custom provider (`baseURL` → the gateway). LiteLLM defines named routes (at minimum one cheap and one strong model), enforces a hard budget, and is the system of record for cost. **OpenRouter** sits behind LiteLLM as one upstream; LiteLLM can add or swap upstreams without changing harness config.

## Consequences

- Per-persona routing reduces to pointing each agent's `model:` at a LiteLLM route name; upstream choice and pricing are decoupled from the harness.
- Cost is tracked in LiteLLM's dashboard — the single place spend is visible. The $250/month target is measured there, not in OpenCode.
- Hard budgets give a real spend ceiling the incumbent lacked.
- Adds one process to run and keep portable (Linux + macOS); credentials stay in env, never in committed config.
- Capability detection for custom-provider models is limited in OpenCode (token limits set manually; reasoning/vision misclassified) — acceptable for text/code agentic work.

## Alternatives considered

- **OpenCode → OpenRouter directly** — simplest, but no hard budgets, no unified cost dashboard, and no place to centralize routing policy. Rejected: loses the observability that justifies the project.
- **A bespoke proxy** — full control, but reinvents what LiteLLM already does (routing, budgets, cost accounting, broad provider support).

## Open questions

- The exact cheap/strong model pair and the routing policy that hits the cost target while holding build quality (tuned post-spike; the spike measures, it does not optimize).
- Whether per-persona budget caps (not just a global cap) are worth configuring early.
