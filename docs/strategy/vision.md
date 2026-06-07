# agent-harness — vision

## What it is

agent-harness is an open, self-hosted runtime for an autonomous multi-agent software-engineering fleet. It re-platforms an existing, proven orchestrator design — a fleet of role-specialized agent personas (a direction-setting chief, autonomous and attended executors, feature builders, reviewers, an agenda-setter, and producer agents) that take work from an issue tracker and a chief's direction, build it on isolated branches, review it, and merge it — onto an open harness with per-persona model routing through a self-hosted gateway.

The agent design is the asset. The harness underneath it is a commodity. agent-harness exists to free that design from a single-vendor runtime and to make the cost of running it both controllable and observable.

## Why it exists

Two coupled drivers, which are one effort because the second requires the first:

- **No vendor lock-in.** The incumbent stack is bound to one closed harness runtime. agent-harness runs on an open harness (OpenCode), so the fleet is no longer captive to one vendor's client, pricing, or roadmap.
- **Controllable, observable model cost.** Spend is dominated by long in-session build runs on a single strong model. agent-harness routes each persona to an appropriate model through a self-hosted LiteLLM gateway — a cheap model for mechanical, high-frequency work; a strong model for direction, architecture, and review — with hard budgets and a cost dashboard the incumbent cannot provide. Escaping lock-in is the precondition for per-persona routing; routing is the precondition for the cost win. One effort.

## Who it's for

A single operator running an autonomous agent fleet on their own hardware. The primary target is a headless Linux server, driven over SSH; it must also run on a personal macOS machine. One operator, their own boxes, no multi-tenant or hosted-service ambitions.

## What it must carry (parity bar)

agent-harness is a standalone alternative to the incumbent, chosen at deploy time — feature and reliability parity is the bar, not a subset. It must carry:

- the dispatch → build → PR → token-free-wake lifecycle, with no idle polling cost;
- the full persona fleet, each routable to its own model;
- the autonomous merge loop inside a safe permission intersection, the attended (human-present) executor, and the review gate;
- GitHub as the work and review surface;
- a remote-attach layer so the operator can observe and steer a running fleet from elsewhere;
- an OS/network isolation envelope around the harness — the precondition for running an injectable model unattended. The harness provides no security boundary of its own (its permission config is UX, not a boundary), so unattended operation depends on a container sandbox with default-deny egress and the gateway acting as a credential-injecting egress proxy. See ADR 0007.

## The stack

- **OpenCode** — the open harness. A standalone client-server application: a headless server (`opencode serve`) is the agent engine; the operator's TUI and our substrate are both clients of it.
- **LiteLLM** — the self-hosted gateway: per-persona routing, hard budgets, and the cost observability the incumbent lacks. OpenRouter sits behind it as one upstream.
- **A TypeScript substrate** — the orchestrator process that drives the harness over its HTTP API: dispatch registry, watcher, the wake driver, lifecycle, merge gate, and GitHub/git plumbing. A maintainable codebase, not a pile of shell scripts.

## What success looks like

A build fleet whose monthly model spend is roughly $250 of metered gateway cost while delivering output comparable to what a flat premium subscription delivers in a month — measured by useful work shipped (a merged-PR / build-session proxy), and tracked in the gateway's own spend dashboard. Below that line, with parity held, the re-platform has paid for itself.

## Non-goals

- **Not rebuilding the harness.** We don't reimplement OpenCode. The agent runtime — the loop that reads code, calls tools, talks to the model, edits files — is OpenCode's job, consumed as a commodity. agent-harness is the orchestration design, the per-persona routing, and the substrate *around* that runtime. A persona is a configuration of OpenCode (an agent definition + a model route + a permission set), not a program we write. We orchestrate coding agents; we never build one.
- **Not an abstraction layer over two runtimes.** agent-harness and the incumbent are independent, selectable stacks. They may be co-installed on one box but run one at a time; there is no shared abstraction, no dual runtime, no interop shim between them.
- **No bespoke fleet-manager UI unless proven necessary.** The incumbent's separate control-plane application is presumed unnecessary here — GitHub as the review surface, chief-driven dispatch, and the harness's own client-server attach are expected to cover human-attach and fleet management. A dedicated UI is added only if a concrete gap forces it.
- **Not our job to fix upstream harness bugs.** Known OpenCode limitations (custom-provider capability detection, OAuth-MCP auth) are routed around with documented workarounds, not adopted as our maintenance burden.
- **Not multi-tenant or a hosted service.** One operator, their own hardware. No accounts, no tenancy, no SaaS surface.

## What it is not becoming

A platform, a product for others to run, or a place to reinvent the agent itself. agent-harness is infrastructure for one operator's fleet: port the design, route the models, keep it maintainable and portable, and stay out of the business of building a harness.
