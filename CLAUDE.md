# agent-harness — conventions for builders

This file orients any agent (or human) building in this repo. Read it before writing code.

## What this project is

An open re-platform of a multi-agent orchestrator onto OpenCode + LiteLLM. The agent design is the asset; the harness is a commodity we consume. We **do not reimplement the harness** — the agent loop, tool execution, model calls, and session management are OpenCode's job. We build the orchestration design, the per-persona routing, and the substrate around it. A persona is a *configuration* of OpenCode (agent definition + model route + permission set), not a program.

## Current phase: hardening + measurement

The system is live: Drizzle-backed dispatch registry, dispatch-loop daemon, amend cycle, and session-main as the build surface, with budget guard (ADR 0026). The live phase focuses on hardening and P4 measurement: amend rate, cost-per-feature, and reliability. Backlog: the `agent-harness` Linear team, `port` track, mirrored to GitHub issues.

Model seats: builder = Claude Haiku 4.5 (cheap route, gated by `make gate-builder` acceptance gate — ADR 0025), reviewer = claude-sonnet-4.6 (pinned), chief = claude-sonnet-4.6 (Sonnet now; Opus principal A/B is a planned route).

## Hard conventions

- **Language/runtime:** TypeScript on Bun. Strict TS (`tsconfig.json`). No second runtime — Bun already ships with OpenCode.
- **Secrets:** never commit credentials. Keys come from the environment (`.env`, gitignored; names in `.env.example`). LiteLLM and OpenCode read keys via env only.
- **OpenCode integration:** talk to the running server over its REST API. Generate a typed client from its OpenAPI spec (`GET /doc`) rather than hand-rolling HTTP. Read session state from OpenCode's SQLite store when needed.
- **The wake mechanism is external.** OpenCode plugins are fire-and-forget and cannot re-activate an idle session from inside. Re-activation is the substrate's job: detect idle from outside, then `POST /session/:id/prompt_async`. Do not try to drive the loop from inside a plugin.
- **Personas are config, not code.** Builder/reviewer/etc. are OpenCode agent definitions (markdown/JSON) with a `model:` route and a `permission:` set. Permissions are **last-match-wins** in OpenCode (the inverse of Claude Code) — author allowlists accordingly.
- **GitHub is the build/review surface.** Linear is the product roadmap; a two-way sync mirrors the two. Don't write Linear from build code.

## Coding standards & skills

- **`docs/standards.md`** — the detailed coding standard every change follows (language, module organization, typed boundaries, error handling, testing, secrets, commits). Read it before writing code; it ships in every build chunk's context pack. This file orients; `standards.md` is the rulebook.
- **`docs/skills/`** — operational guides for the recurring "how do I add X" surfaces: `adding-a-substrate-module`, `typed-api-boundary`, `persistence-drizzle`, `adding-a-persona`, `adding-a-model-route`, `adding-an-mcp-tool`, `writing-tests`, `opening-a-pr`. Load the matching skill when you add that kind of surface. These are a **harness-neutral** curated library — ours, not a Claude-Code or OpenCode native skill directory — delivered by guaranteed curated injection into the build context pack (ADR 0018). Index: `docs/skills/README.md`.

## Where things go

- `src/` — the substrate (TypeScript). See `src/README.md`.
- `agents/` — OpenCode persona definitions. See `agents/README.md`.
- `config/` — LiteLLM + OpenCode config. See `config/README.md`.
- `docs/adrs/` — architecture decisions. Honor them; if one is wrong, propose a superseding ADR rather than editing it.

## Decisions of record

The foundational ADRs (`docs/adrs/0001`–`0006`) cover the harness choice, the gateway, the substrate language, the runtime topology, the persona mechanism, and remote attach. They are `proposed` — open to revision, but they are the current frame. Read them before making an architectural change.
