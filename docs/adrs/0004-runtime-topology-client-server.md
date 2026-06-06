# 0004 — Runtime topology: OpenCode as a server, the substrate as an external client

- **Status:** proposed
- **Date:** 2026-06-06

## Context

A common misconception is that OpenCode is an embeddable SDK whose harness features are linked into our process. It is not — it is a client-server application. `opencode serve` is a long-running headless server that *is* the harness (agent loop, tool execution, model calls routed to the gateway, session management, plugin host), exposing a REST API and an OpenAPI spec at `GET /doc`. The TUI, the `opencode run` CLI, and our substrate are all clients of that server. How the substrate integrates, how work is dispatched, and how the token-free wake loop is built all follow from this fact.

A second relevant fact: OpenCode plugins are fire-and-forget and cannot re-activate an idle session from inside the harness — there is no equivalent of an in-harness hook that re-queues work.

## Decision

Adopt a **client-server topology** with three processes on the box, plus plugins inside the harness:

1. **LiteLLM gateway** (Python) — routing, budgets, cost dashboard (ADR 0002).
2. **`opencode serve`** (Bun) — the harness; provider pointed at the gateway; loads our agents, commands, and TS plugins; persists sessions to SQLite.
3. **The substrate** (TypeScript/Bun, ADR 0003) — the orchestrator: dispatch, watcher, the wake driver, merge gate, gh/git. Drives OpenCode over its HTTP API and reads its SQLite session store.

The **token-free wake is external**: the substrate detects a session going idle from outside the harness and re-activates it with `POST /session/:id/prompt_async`. The wake loop is never driven from inside a plugin.

## Consequences

- Replaces the incumbent's `tmux send-keys` injection with clean HTTP — and gives the substrate a typed contract to drive.
- Human-attach falls out of the architecture: multiple clients can attach to one running server, so the substrate drives a build while a human attaches a TUI to observe and steer (ADR 0006). This is the basis for the no-bespoke-UI bet.
- The substrate owns idle detection and re-activation; plugins handle only in-session, fire-and-forget concerns.
- Three processes to supervise and keep portable.

## Alternatives considered

- **Embed an agent SDK in-process** (the Cline model) — would collapse to fewer processes, but forfeits OpenCode and the multi-client attach that gives us Remote Control for free. Out of scope given ADR 0001.
- **In-harness wake via plugins** — not possible; plugins cannot resume an idle session.

## Open questions

- Exact attach fidelity: can a human TUI observe and steer the *precise* session the substrate drives, or only sibling sessions on the same server? (Spike G6 / AGENT-5.)
- The precise idle signal the substrate keys on (`session.idle` event vs. a polled server state). (Spike G4 / AGENT-8.)
