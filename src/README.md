# src — the substrate

The TypeScript/Bun orchestrator process that drives OpenCode over its HTTP API. This is **ours** — the maintainable spine that replaces the incumbent's bare shell scripts.

**Not yet implemented — this is the frame.** The substrate is built across the spike:

- **AGENT-7 (B5) — dispatch + build leg:** take an issue → create a branch → spawn the builder (cheap route) via the OpenCode HTTP API → produce a PR. Uses a typed client generated from OpenCode's OpenAPI (`GET /doc`).
- **AGENT-8 (B6) — review + wake leg:** detect builder idle from outside the harness → spawn the reviewer (strong route) via `POST /session/:id/prompt_async` → capture the review.

Intended early module shape (refine as built):

```
src/
  index.ts            # entrypoint / CLI for the substrate
  opencode/           # generated typed client + thin wrappers over the REST API
  dispatch/           # issue → branch → build-leg; the plan→dispatch service + daemon
  substrate/          # bounded contexts (dispatch registry, plan) — model/schema/repository (ADR 0017)
  mcp/                # the substrate MCP server — status/dispatch tools the chief calls (ADR 0019)
  wake/               # idle detection + prompt_async wake driver
  github/             # gh/git plumbing, PR creation, merge gate
```

Keep seams clean: this code is the seed of the production substrate, not a throwaway POC.
