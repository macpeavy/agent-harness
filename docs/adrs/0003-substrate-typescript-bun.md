# 0003 — Substrate language and runtime: TypeScript on Bun

- **Status:** proposed
- **Date:** 2026-06-06

## Context

The incumbent substrate is ~30 bare shell scripts (dispatch registry, watcher daemon, lifecycle, teardown, pane-inject, signal/transcript/context plumbing). They are unreadable and hard to maintain; the re-platform is the moment to rebuild them as a real codebase rather than port them as-is. The substrate is an external orchestrator process that drives OpenCode — its work is HTTP client calls, SQLite reads, child-process/`gh`/`git` management, and a long-running daemon loop.

The choice of language reopened once the survey established that OpenCode is TypeScript/Bun and that its plugin/hook system is mandatorily TypeScript. With plugins forced to TS, a Python substrate would make the project polyglot (TS plugins + Python substrate + YAML), where TS keeps it near-monoglot.

## Decision

Write the substrate in **TypeScript**, running on the **Bun** runtime that OpenCode already requires. Build it as a structured, testable codebase — the maintainable spine that replaces the shell scripts — not a collection of scripts.

## Consequences

- One runtime per box: Bun serves OpenCode, its plugins, and the substrate — a single toolchain to keep portable across Linux and macOS instead of two.
- A typed integration seam: the substrate generates/uses a typed client from OpenCode's OpenAPI spec (`GET /doc`), directly serving the maintainability goal that motivated leaving shell.
- Plugins and substrate share a language and can share types.
- Daemon/orchestration code in TS (long-running process, child-process management, SQLite access) is slightly less idiomatic than in Python but well within Bun/Node's reach.
- LiteLLM being Python is a non-factor — it is consumed over HTTP and configured in YAML.

## Alternatives considered

- **Python** — the initial instinct (strong for ops glue, and LiteLLM's language). Rejected once OpenCode's TS/Bun nature and mandatory-TS plugins were known: it would add a second language and a second runtime for no offsetting benefit, since LiteLLM is reached over HTTP regardless.
- **Keep shell** — rejected outright; unreadability is the problem being solved.

## Open questions

- The substrate's internal module boundaries (dispatch / wake / github / opencode-client) — seeded in the spike (AGENT-7/8), hardened as the full substrate is built.
