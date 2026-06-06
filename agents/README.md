# agents — OpenCode persona definitions

Personas are **configurations of OpenCode**, not code: a markdown (or JSON) agent definition with a `model:` route and a `permission:` set. This directory holds them.

**Built in AGENT-4 (B3).** The spike needs two:

- `feature-builder` — pinned to the **cheap** LiteLLM route; `mode: subagent`. Builds the work.
- `reviewer` — pinned to the **strong** route; `mode: subagent`. Reviews the PR.

Both get a **safe-intersection** permission set for unattended runs: allow the known-safe tool set (read/edit/grep/glob, scoped `git`/`gh`/build bash), `ask`/`deny` the rest. OpenCode permissions are **last-match-wins** — author allowlists with that ordering in mind.

The full persona fleet (chief, orchestrator, etc.) is deferred to the post-spike port; the spike is builder + reviewer only. Persona *content* (role prose) ports from the incumbent design — see the discovery record.
