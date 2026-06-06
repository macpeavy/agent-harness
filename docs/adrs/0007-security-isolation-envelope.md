# 0007 — Security & isolation envelope: the OS/network boundary around the harness

- **Status:** proposed
- **Date:** 2026-06-06

## Context

A security review of OpenCode (`research/2026-06-06-opencode-security-profile.md` in the discovery workspace) found that the harness we adopted in ADR 0001 ships **no security boundary of its own**, and its maintainers say so explicitly: *"OpenCode does not sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking,"* with "sandbox escapes" and "malicious configuration files" listed as out of scope. Three findings make this load-bearing for us:

1. **No native network-egress control.** A prompt-injected agent with `bash` can exfiltrate via `curl`/`wget`/`nc`/DNS; even with bash fully denied it retains `webfetch`, `websearch` (proxied to Exa), remote MCP, plugin sockets, and the model API call itself as exfil channels. None of these are controllable from inside OpenCode.
2. **The permission matcher is bypassable, and — directly relevant — the SDK/API path ignores `deny` rules entirely** (issue #6396). Our substrate (ADR 0004) drives OpenCode over its HTTP API, which is exactly that path. So the deny-floor we authored in config (`opencode.json`, PR #13) is **defense-in-depth at best and may be inert for our primary driver**. The config is UX-grade noise reduction, not a control plane.
3. **The threat actor is our own cheap model.** The cost thesis (ADR 0002) routes the builder to a cheap, easily-injectable model. Running it unattended means a daemon re-prompting an idle, injectable agent in a loop, with no human valve — OpenCode's `ask` action hangs forever headless (#14473), so there is no human-in-the-loop middle ground once autonomous.

Two recent critical CVEs (CVE-2026-22812, RCE, CVSS 8.8; CVE-2026-22813, XSS→RCE, CVSS 9.4) were in the `serve`/web surface we run; we are on 1.16.2, past both. The surface that an unattended deployment leans on is the surface that has had back-to-back critical RCEs.

**One property is already in our favor.** Per ADR 0002, the OpenRouter key lives only in the LiteLLM gateway's environment; OpenCode holds only a local master key to the localhost gateway. The valuable credential is already off the agent's reach. This ADR turns that accident into a deliberate boundary.

This ADR does not change the harness (0001), the gateway (0002), the logical topology (0004), or the attach model (0006). It places all of them inside an isolation envelope and states where the boundary sits. It is the missing foundational decision those four assumed but never made.

## Decision

Run the harness inside an **OS/network isolation envelope** whose load-bearing controls are external to OpenCode. OpenCode's own permission config is retained as defense-in-depth UX, never relied on as a boundary.

**1. Sandbox: a container, not a microVM or full VM.** Run `opencode serve` and the substrate (ADR 0004's processes 2 and 3) inside a single long-lived **Docker container** (the operator's tooling of choice; ports across Linux and macOS). Run it **non-root** (a `USER` directive), with **dropped capabilities** and rootless Docker where practical — Docker's default rootful daemon is the one place it is looser than a daemonless runtime, and that gap is closed in config, not by changing runtimes. Read-only root filesystem where possible, only the target repo bind-mounted, no host credential mounts (`~/.ssh`, `~/.aws`, host `auth.json`/`mcp-auth.json` never visible inside). The security properties this ADR depends on — egress control, filesystem scoping, credential isolation — are identical across container runtimes; the runtime choice is an operator-ergonomics call. The container is the unit of isolation, chosen over a microVM (KVM-only, does not port to the required macOS target) and a full VM (ops weight unjustified for a solo operator). The threat is exfiltration by an injected agent, which egress control + credential isolation + filesystem scoping fully address; it is not a kernel-escape adversary. A **single long-lived** container preserves ADR 0004's persistent client-server topology — it is not the per-task sandbox model 0004 rejected; "direct-host" there meant "not a fresh sandbox per build," and one durable sandbox honors that.

**2. The gateway sits OUTSIDE the sandbox, as the egress proxy.** LiteLLM (ADR 0002, process 1) runs on the host or in a separate container, **not** inside the agent's sandbox. The sandbox's egress allowlist makes the gateway the agent's only route to any model. LiteLLM is therefore the sole holder of the OpenRouter key and the sole process that can reach OpenRouter. ADR 0002's gateway gains a second load-bearing role: cost spine **and** credential-injecting egress proxy. A fully-injected agent that defeats every permission rule can reach only LiteLLM, which injects the real key it never sees; its own master key is bounded by the gateway's hard budget, so even a leaked master key caps at the spend ceiling.

**3. Default-deny network egress.** The sandbox drops all outbound traffic except an explicit allowlist (iptables/nftables default-DROP, or a filtering proxy). The allowlist is the minimum the loop needs:
   - the **LiteLLM gateway** address (the model path);
   - **GitHub** — `github.com` + `api.github.com` (git push, `gh` PR/issue operations; GitHub is the work and review surface);
   - **package registries** required to build — `registry.npmjs.org` (and the specific registries a built repo needs);
   - a **pinned DNS resolver** (arbitrary DNS is itself an exfil channel — do not leave it open).
   Everything else is dropped at the network layer regardless of OpenCode config. This single control neutralizes `bash` curl/nc, raw `webfetch`, rogue MCP, and plugin sockets at once.

   **Web access is a per-context capability, brokered — not a permanent global denial.** The boundary forbids *unbrokered, arbitrary* outbound from the autonomous untrusted-content persona; it does not forbid web research as a feature. Web reaches the agent through a **filtering forward-proxy that is itself the egress control** — the only allowed outbound path, logging every URL as an auditable chokepoint, with a per-context domain policy. The **unattended builder context runs web-off** (it does not need the web to build). An **attended research/assist context enables web through that same proxy**, under the operator's intent and eyes. This leaves us strictly more controlled than the incumbent (Claude Code grants wide-open `WebSearch`/`WebFetch` with no egress filter): we keep the boundary for the builder and broker web for research, with the valuable credential already off the box. The residual — an attended research context could encode a secret into a URL through the proxy — is the risk the incumbent already runs unattended; we accept it *only* attended. Web research is post-spike (the spike is builder + reviewer only); this records the seam so the boundary does not foreclose it.

**4. Credential & transcript containment.** The OpenRouter key is present only in the out-of-sandbox gateway. The agent pushes with a **deploy key scoped to the single repo under build**, not an account-wide PAT, so even a successful push is contained to one repo. The session store (transcripts) stays on the sandbox volume and is never shipped off-box; `/share` is disabled (already set in PR #13) and assume transcripts contain every secret the agent touched.

**5. OpenCode config remains, as defense-in-depth UX only.** The deny-by-default bash allowlist, denied `webfetch`/`websearch`, denied secret-file reads, disabled share, and ≥1.1.10 version floor (PR #13) stay. They reduce accidental noise and cover the attended/TUI path where rules *are* honored. They are never the boundary; the four controls above are.

## Consequences

- The exfiltration surface collapses to a deliberate allowlist. The remaining egress channels are the gateway (no valuable credential reachable, budget-capped) and GitHub (repo-scoped, human-reviewed) — both intended, both contained.
- ADR 0002's gateway becomes load-bearing for security, not only cost. This is reinforcement, not conflict: the existing architecture already put the valuable key there.
- **The spike thesis is provable entirely attended, so the envelope does not block it.** None of gates G1–G4 require unattended running; G4 is a single demonstrated wake, not a standing loop. The envelope gates the step *after* the thesis — operating the proven loop unattended, and any deployment — not the spike itself. The attended spike proceeds in parallel with envelope construction.
- One genuine residual exfil path remains after hardening: an injected agent could push secrets to GitHub over the allowed egress. It is mitigated, not closed — by the repo-scoped deploy key and by every push surfacing as a human-reviewed PR. We do not pretend it is sealed.
- Operational cost: a container to build and keep portable across Linux and macOS, an egress firewall to maintain, and a deploy-key rotation discipline. Acceptable for the safety it buys; all three are one-time setup plus light upkeep.
- OpenCode is a fast-moving commodity dependency with a demonstrated record of critical RCEs in its server surface. ADR 0001's "pin and validate" becomes a **standing advisory-watch obligation**: track `anomalyco/opencode` security advisories, treat any `serve`/web advisory as a priority upgrade, and validate upgrades against the spike gates before adoption.

## Alternatives considered

- **Rely on OpenCode's permission config as the boundary.** Rejected outright — the maintainers disclaim it, the matcher is bypassable, and the SDK/API path our substrate uses may ignore `deny` entirely (#6396). This is the status quo the review refuted.
- **A dynamic per-task permission generator** (tailor the safe-intersection per dispatched issue). Demoted to secondary/post-spike. It generates rules our own API-path driver may ignore (#6396), so it polishes a control plane that is not load-bearing for our architecture. It has real value as attended-path operator ergonomics and blast-radius reduction where rules *are* honored — but it is explicitly not the boundary and must not consume spike attention. The egress firewall is the boundary.
- **microVM (Firecracker/Cloud Hypervisor).** Strongest isolation-per-weight, but KVM-only — it does not port to the macOS target the vision requires — and it is heavy ops for a solo operator against a threat (agent exfil) that does not need kernel-grade isolation.
- **Full VM per box / sandbox-per-task (OpenHands model).** Rejected for ops weight and for collapsing ADR 0004's persistent multi-client server into a per-task lifecycle. ADR 0001 already rejected OpenHands on this exact ground.

## Open questions

- The exact scope of #6396: does the REST API path (`prompt_async`, our substrate's driver) ignore `permission.deny` for all permissions or only custom-agent ones, for primary and subagent alike? An empirical probe settles how much, if anything, the config layer buys our primary path (filed as the security-track probe issue).
- Host-process vs sibling-container for LiteLLM — an implementation choice the build settles; both honor this ADR. (Runtime: Docker, decided — see Decision point 1.)
- The brokered web-research context: which forward-proxy (Squid SNI peek/splice or similar), the default domain policy for an attended research persona, and how the proxy's URL log is retained and reviewed. Post-spike, when the research/assist persona is ported.
- Whether the egress allowlist needs per-build-repo registry entries (a repo that pulls from a private or non-npm registry) — handled case by case at dispatch.
- Whether inbound attach (ADR 0006) is best served by SSH into the host then into the container, or by exposing the server port only on the Tailscale interface. The envelope constrains attach to the trusted interface; the mechanism is an 0006 follow-up.
