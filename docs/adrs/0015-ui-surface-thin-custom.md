# 0015 — UI / observation surface: a thin-custom two-pane GUI

- **Status:** proposed
- **Date:** 2026-06-07
- **Supersedes:** 0006 (the "no bespoke UI" stance; 0006's SSH/Tailscale attach stands as the interim and escape hatch)

## Context

ADR 0006 decided remote attach through the harness's client-server surface (TUI over SSH/Tailscale) plus GitHub, and **no bespoke fleet-manager UI unless a concrete gap forces it**. The owner now wants a "dashboard + chat surface like Claude Desktop" — a GUI to converse with the chief and watch the fleet at a glance. The gap is deliberately forced; this ADR records the resulting decision and supersedes 0006 on the no-UI point.

A competitive survey (`research/2026-06-07-fleet-ui-survey.md`, 10 products) found **no off-the-shelf fit** for the two-pane (chief chat + fleet table) shape:
- **Generic chat shells** (LibreChat, Open WebUI, LobeChat, AnythingLLM) assume a *stateless completions* backend. OpenCode is a *long-running async session*, so adopting any of them forces a stateful completions-proxy we would own forever — and they carry heavy CVE history (Open WebUI SSRF + XSS→RCE, LobeChat two 9.0 SSRFs) plus a multi-user RBAC/LDAP/SSO layer that, for a single operator behind Tailscale, is pure attack surface with no benefit.
- **Orchestration dashboards** (Mission Control) are the best dashboard match but add a registration/heartbeat protocol on top of our dispatch registry and a 31-panel surface that is overkill for 3–5 agents.
- **OpenCode's own web UI** is the exact surface that had the two critical RCEs (disabled by default since 1.1.10), is single-session, and has no fleet view.

## Decision

Build a **thin custom two-pane surface**, served over Tailscale to the single operator:
- **Chief chat pane** — a streaming conversation with the chief, wired to the chief session's events over **OpenCode's session API** (SSE / `/event`). Because we build the surface, it speaks the session API **directly** — it is simply another client of `opencode serve` (ADR 0004's multi-client model), so there is **no completions-proxy** and no impedance mismatch.
- **Fleet status grid** — a read-only render of the dispatch registry (ADR 0009): per dispatch, its state, route, amend rounds, escalation, PR link, cost.

**Minimal by design.** No multi-user RBAC / SSO / LDAP — Tailscale is the network/auth boundary and the operator is the only user. Small attack surface, purpose-fit to the two things the operator needs. Monoglot Bun/TypeScript (ADR 0003): **React** on the frontend; a lean Bun backend (**Hono**) or a unified **Next.js** — the exact stack decided at build time.

**Sequenced last.** The GUI comes after the spine, the planner, and the fleet are real. The **interim** is what 0006 already provides and this ADR keeps: the **OpenCode TUI over SSH/Tailscale** for chat, plus a **minimal terminal status read** over the registry for the fleet glance. So the UI never blocks build work, and the SSH/Tailscale attach remains the escape hatch even after the GUI ships.

## Consequences

- Reverses 0006's no-bespoke-UI stance, deliberately — the owner forced the gap. The rest of 0006 (attach over the client-server surface on the trusted interface) stands as the interim and the always-available escape hatch.
- Building thin-custom *avoids* the proxy that adopting any generic shell would require, and avoids inheriting their attack surface — for a security-hardened single-operator deployment (ADR 0007), the thin surface is both less work on the hard part and safer.
- The UI is another session-API client of `opencode serve`, so it composes with the existing topology rather than adding a new integration plane.
- We own a (small) UI codebase. Scoped to two panes for one operator, that is a bounded cost; the survey estimates ~1–3 weeks when we build it.
- Sequencing last means near-term observation leans on the TUI + terminal status read — which is why the registry's status read (AGENT-18/23) is worth having early regardless.

## Alternatives considered

- **Adopt a generic chat shell + a completions-proxy.** Rejected — we would own the stateful proxy forever (the hard part) *and* inherit a large multi-user attack surface we don't need.
- **Adopt Mission Control (the best off-the-shelf dashboard).** Rejected for now — it adds a heartbeat/registration protocol over our registry and 31 panels for 3–5 agents. Remembered as the option if the dashboard ever outgrows a simple status grid.
- **OpenCode's own web UI.** Rejected — the CVE surface, single-session, no fleet view.
- **Stay terminal-only (keep 0006 as-is).** Rejected as the end state (the owner wants the GUI) but adopted as the **interim**.

## Open questions

- Exact stack: Bun+Hono+React+Vite vs. Next.js vs. CopilotKit (AG-UI) — decided at build (sequenced last).
- Whether the chat pane drives the *same* chief session the operator uses in the TUI, or a sibling session on the same server (attach fidelity — ties to G6/AGENT-5).
- Whether Mission Control becomes worth adopting if the dashboard grows beyond a status grid.
