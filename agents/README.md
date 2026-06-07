# agents — OpenCode persona definitions

Personas are **configurations of OpenCode**, not code: a markdown (or JSON) agent definition with a `model:` route and a `permission:` set. This directory holds them.

The fleet so far:

- `builder` — pinned to the **cheap** LiteLLM route. Builds one chunk, opens a PR. (`builder-nano` / `builder-gemini` are validated Western alternates on the same prose, AGENT-17.)
- `reviewer` — pinned to the **strong** route; read-only (`edit: deny`). Reviews the PR, returns ranked findings.
- `chief` — pinned to the **strong** route (`litellm/chief`, Sonnet); `mode: primary`, owner-facing. Decomposes features into cheap-able chunk-DAGs and drives the fleet through the substrate MCP (`decompose`/`dispatch`/`status`); **never builds** (`edit`/`bash`/`task: deny`). The decomposition / cost engine (ADR 0019). `principal`/Opus is the later A/B.

Permissions are **least-privilege** and OpenCode is **last-match-wins** (the inverse of Claude Code) — author allowlists with that ordering in mind. The substrate MCP tools are scoped by persona: `chief` allows `substrate_*`; the builders/reviewer deny it (they build/review, they don't drive the substrate — ADR 0007). Persona *content* (role prose) ports from the incumbent design.

The broader fleet (orchestrator, producers, principal) is deferred to the later port (AGENT-27).
