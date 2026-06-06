# 0005 — Persona mechanism: personas as OpenCode configuration

- **Status:** proposed
- **Date:** 2026-06-06

## Context

In the incumbent, a persona is realized through harness-specific machinery: Task sub-agents, skills with a load-and-require convention, slash commands, lifecycle hooks, and a permission allowlist — all implicitly assuming a single strong model. Porting the *design* means re-expressing these mechanisms on OpenCode without reimplementing the harness. OpenCode provides direct analogues for most of them, and the per-persona routing goal requires that each persona be invocable on its own model.

## Decision

Realize each persona as **OpenCode configuration, not code**:

- **Agent definition** — a markdown (or JSON) file (`agents/<name>.md`) with `description`, `mode` (primary/subagent), a `model:` route (the per-persona routing lever, ADR 0002), and a `permission:` block. The role prose ports from the incumbent design.
- **Skills / commands** — OpenCode skills and markdown slash commands (`commands/*.md`). The skill load-on-demand mechanism is under-documented and is verified before the full skills port.
- **Hooks** — OpenCode's TypeScript plugin system (lifecycle events such as `tool.execute.before/after`, `session.*`). Hook *logic* ports as plugins; the incumbent's in-harness re-queue pattern does not port and is externalized to the substrate (ADR 0004).
- **Permissions / safe-intersection** — OpenCode's `allow`/`ask`/`deny` model, per-agent override. The unattended safe-intersection is expressed as a default `ask`/`deny` with explicit `allow` patterns. Note OpenCode is **last-match-wins** (the inverse of the incumbent) — allowlists are authored accordingly.

## Consequences

- Personas become declarative artifacts diffable in the repo; adding or routing a persona is a config change, not a code change.
- The single-strong-model assumption is removed: routing is a per-agent `model:` field.
- Hook behavior splits cleanly — in-session concerns live in plugins; cross-session re-activation lives in the substrate.
- The permission inversion (last-match-wins) is a porting gotcha that must be applied consistently when translating the incumbent allowlist.
- Linear, an interactively-authenticated MCP server, does not authenticate cleanly under OpenCode's OAuth-MCP (a known token race). A viable path (Composio proxy / stdio / REST-via-tool) is probed separately; Linear is not on the build loop's critical path.

## Alternatives considered

- **Reimplement a sub-agent/skill framework ourselves** — contradicts the commodity-harness principle (ADR 0001) and the "not rebuilding the harness" non-goal.
- **One model for all personas** — abandons the cost lever, defeating the project's purpose.

## Open questions

- The exact OpenCode skills load mechanism and how faithfully the incumbent skills port (verified before the full port).
- Which interactively-authenticated MCP integrations survive the port and through which surface (spike G5 / AGENT-2).
