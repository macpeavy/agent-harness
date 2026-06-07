# 0012 — Interaction model: the chief as driver, the substrate as its hands

- **Status:** proposed
- **Date:** 2026-06-07

## Context

The single most important property of the product, per the owner, is that **the chief is the driver of everything — including dispatching the fleet, with the owner's approval** — and a close second is the prompting UX: how the owner actually interacts with the system. The prior ADRs settled the cost architecture (decomposition, amend, registry, model tiers) and the execution shape (fleet-dispatched, attended at merge). This ADR settles how a human drives it and where they sit, so the product is nailed down before it is built.

## Decision

**The chief is the brain, the substrate is its hands, the fleet is its muscle.**

**1. The chief drives; its tools are the fleet.** The chief is a strong-route OpenCode agent (`chief`/`principal`, ADR 0010) that the owner converses with. It holds direction, reads the repo, and decomposes intent into chunks. It does not fan out work itself — it calls **substrate-provided tools** (`dispatch`, `status`) that express intent; the **substrate** performs the actual fan-out over the **direct session API** — the path the spike proved, deliberately not OpenCode's experimental sub-agent/task tool. So the chief never touches the risky path; it reasons and requests, and its hands (the substrate) execute reliably.

**2. Dispatches are bounded.** A fleet session is a **bounded batch** of chunks, never an open-ended "build the whole app." Bounding is what makes single-approval safe and keeps the blast radius and the owner's approval load small. The chief decomposes into bounded batches; the owner approves a batch at a time.

**3. Two approval gates, both the owner's, each in its natural home.**
   - **Dispatch approval** — inline in the conversation. The chief proposes the chunk-DAG + dispatch plan; the owner approves / edits / holds ("dispatch 1–3, hold 4, re-split 2"). Nothing spawns until the owner says go. Approve-the-batch-once, with per-dispatch override.
   - **Merge approval** — on GitHub. The fleet's output is PRs; the owner approves and merges where review already lives.
   Trivially-safe chunks (the spike's one-shot-mergeable class) may earn auto-merge **only post-envelope** (ADR 0007), never before.

**4. The prompting UX: converse with a persistent chief; autopilot to the gates.** The owner talks to a persistent chief (OpenCode TUI or a thin `harness chief` CLI, over SSH/Tailscale for remote — ADR 0006, no new app) the way they talk to the incumbent chief: natural-language intent, the chief plans, the owner approves at the two gates, and the chief autopilots everything between them. The bounded batches are what make autopilot-to-the-gates safe.

**5. Observation: a glance, a deep-dive, the output.**
   - A **thin read-only status surface** rendering the registry (what is building / in review / amending / escalated) — the glance. This is now in scope; it is the acknowledged concrete gap that ADR 0006 reserved a UI for, kept minimal (a rendered registry read, not a prism rebuild).
   - **Attach** to any individual session (ADR 0006) for watching or steering one build live.
   - **GitHub** for the output.

## Consequences

- The chief is a first-class driver, not a planner that hands off to a separate loop — matching the owner's primary requirement. The substrate is subordinate machinery the chief commands through tools.
- Keeping fan-out in the substrate (not the chief's agent context) holds the line on the spike's central finding: concurrency is reliable via the direct session API, fragile via the experimental task tool. The chief's `dispatch` tool is a clean request, not a sub-agent spawn.
- Bounded dispatches make the human approval gates cheap and the autopilot safe; they also cap how much a bad decomposition can cost before the owner sees it.
- The status surface is a real (small) build item and a partial reversal of ADR 0006's "no bespoke UI" default — taken because watching a live fleet in a single conversation is genuinely awkward. It stays read-only and registry-backed.
- The two-gate model means throughput is governed by owner attention at exactly the two points that matter (decomposition quality, merge safety) and nowhere else.

## Alternatives considered

- **Chief fans out work itself via OpenCode's sub-agent/task tool.** Rejected — that is the experimental path the spike sidestepped; concurrency was proven at the substrate layer. The chief requests; the substrate fans out.
- **Artifact-mediated approval** (chief writes a plan to a tracker, owner approves there). Rejected as the primary path — slower and less direct than inline conversational approval; the tracker remains the record, not the approval surface.
- **A full prism-equivalent fleet-manager UI.** Rejected — the thin registry status read plus GitHub plus attach covers the need; a full control-plane app is the thing ADR 0006 declined and nothing yet forces.
- **No human merge gate (auto-merge on clean review).** Rejected pre-envelope; revisitable for trivially-safe classes only after ADR 0007 closes.

## Open questions

- Whether the status surface is a terminal renderer (`harness status`) or a minimal web view behind Tailscale — decided when it is built; terminal-first is the likely start.
- The exact shape of the substrate `dispatch`/`status` tools the chief calls (an MCP server the chief loads, vs. native tools) — an implementation choice for the chief-analogue port (AGENT-21).
- How mid-build steering (owner injects a directive while a batch runs) routes — through the chief, or by direct attach (ADR 0006) — refined under G6/AGENT-5.
