# 0001 — Harness: OpenCode

- **Status:** proposed
- **Date:** 2026-06-06

## Context

agent-harness re-platforms a proven multi-agent orchestrator off a single closed harness runtime onto an open one. The harness must support the mechanisms the design depends on: a sub-agent primitive (to fan out role-specialized personas), per-agent model selection (the per-persona routing that the cost goal requires), an OpenAI-compatible provider seam (to sit behind a self-hosted gateway), custom personas/commands, a permission model expressible as an unattended safe-intersection, MCP client support, a headless/scriptable drive, and externally readable session state. The target environment is a headless Linux server with macOS portability.

A survey of open coding-agent harnesses (OpenCode, Cline, OpenHands, Goose, Aider, Crush, Kilo, Amp, Continue) found OpenCode is the only terminal-native option combining all of: a sub-agent task tool, per-agent model pinning, a documented custom OpenAI-compatible provider, a REST server for external orchestration, and a plugin system with lifecycle hooks. Cline's SDK is the nearest alternative but leans on VS Code and has a thinner server API.

## Decision

Adopt **OpenCode** (the actively maintained TypeScript/Bun project, MIT licensed) as the harness. Consume it as a commodity runtime; do not modify or fork it. Route around its known limitations with documented workarounds rather than upstream fixes.

## Consequences

- Per-persona model routing, sub-agent fan-out, and external orchestration are all expressible on a single open harness.
- We inherit OpenCode's release velocity (multiple releases/week): fixes arrive fast, but so do regressions — pin versions and validate upgrades.
- Three known caveats must be managed: background subagents are experimental (the spike's central risk, gate G1); custom-provider capability detection misclassifies reasoning/vision models (text/code work unaffected); OAuth-MCP has a token race (affects Linear — see ADR 0005 and the G5 probe).
- macOS portability is supported (Homebrew/npm; config under `~/.config/opencode/`).

## Alternatives considered

- **Cline SDK** — strong per-agent routing and the most mature embeddable SDK, but VS-Code-leaning and a weaker headless server story. Retained as the fallback if the spike finds OpenCode's fan-out unstable.
- **OpenHands** — native LiteLLM, strongest headless story, but a Docker-sandbox-per-task model incompatible with the direct-host design.
- **Goose / Kilo / Aider / Crush / Continue / Amp** — each fails at least one load-bearing requirement (no sub-agent primitive, VS-Code-bound, or closed source).

## Open questions

- Does the experimental background-subagent system hold under a 3–5 persona fan-out? (Spike G1; a failure triggers the Cline-SDK fallback.)
- Which OpenCode version do we pin for the spike, given the high release cadence?
