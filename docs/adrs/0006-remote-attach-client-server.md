# 0006 — Remote attach and human-in-the-loop via the harness's client-server surface

- **Status:** proposed
- **Date:** 2026-06-06

## Context

The single biggest risk in the re-platform is Remote Control UX — the operator's ability to observe and steer a running fleet from a phone, browser, or laptop. The incumbent decomposes this: terminal attach is already tmux + Tailscale SSH (harness-independent and ours), and directive injection is pane-inject — also ours. The genuinely Claude-Code-coupled piece was a bespoke control-plane/human-attach application. The question is whether agent-harness needs to rebuild that, or whether the open stack already covers it.

OpenCode's client-server topology (ADR 0004) is decisive here: multiple clients can attach to one running `opencode serve`, and the server exposes prompt-injection endpoints over HTTP.

## Decision

Provide remote attach through the **harness's own client-server surface plus the existing terminal stack**, and add **no bespoke fleet-manager UI unless a concrete gap forces it**:

- **Observe + steer:** a human attaches a TUI client to the same `opencode serve` the substrate is driving, over SSH on Tailscale. Directive injection uses the server's HTTP prompt endpoints (or the TUI directly), not a custom protocol.
- **Browser access (optional):** a web terminal (ttyd/gotty) behind Tailscale Serve, when a non-terminal surface is wanted.
- **No prism-equivalent by default:** GitHub is the review surface and chief-driven dispatch covers fleet management. A dedicated control-plane app is reconsidered only against an explicit, demonstrated need.

## Consequences

- The human-attach layer is native to the harness, not a component we build and maintain — directly retiring the top risk if attach fidelity holds.
- Expect a UX downgrade versus a polished bespoke client, not a blocker; mobile uses an SSH client (Blink/Termius) over Tailscale.
- Drops a large surface (a fleet-manager UI) from scope, consistent with the project's non-goals.

## Alternatives considered

- **Port/rebuild the bespoke control-plane UI** — large surface area; presumed unnecessary given GitHub + chief dispatch + native attach. Held in reserve, not built.
- **OpenCode's own desktop/web clients** — exist but are beta and not relevant to the headless-server use case; treated as a bonus, not a dependency.

## Open questions

- Attach fidelity: can a human TUI observe and steer the *exact* session the substrate drives, or only sibling sessions on the same server? This determines how good the no-UI experience really is (spike G6 / AGENT-5).
- Whether a thin read-only status surface (beyond GitHub) is eventually warranted — deferred until the spike shows what observing a live fleet actually feels like.
