# config — gateway + harness configuration

Configuration for the two infrastructure processes. **Skeletons only here; the real configs are built in the spike.** No secrets ever — credentials come from the environment (`.env`, see `.env.example`).

- **LiteLLM gateway — AGENT-1 (B1).** A `litellm` config defining ≥2 routes via OpenRouter: one cheap (Gemini Flash–class), one strong (Claude Sonnet/Opus–class), with a hard budget. Reachable at a stable localhost base URL (e.g. `http://localhost:4000/v1`).
- **OpenCode — AGENT-3 (B3) (provider wired in AGENT-2/B2).** An `opencode.json` defining LiteLLM as a custom `@ai-sdk/openai-compatible` provider (`baseURL` → the gateway), plus per-agent model pins. Model names must match the gateway's route names.

Commit example/templated configs (`*.example.*`) with placeholders; keep live configs with real endpoints out of version control if they embed anything environment-specific.
