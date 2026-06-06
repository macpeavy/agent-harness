# Strategy brief — 2026-06-06

*Project: agent-harness*
*Period reviewed: spike in flight (AGENT-1/3/4 landed or open; AGENT-5–9 queued) + the OpenCode security review*

## Executive summary

A security review of OpenCode found the harness ships no security boundary of its own — the maintainers say so explicitly — and, for our specific architecture, the config-layer hardening we just landed (PR #13) may be **inert on the path that matters**: the substrate drives OpenCode over its HTTP API, and that path reportedly ignores `deny` rules (#6396). The control plane therefore cannot live in OpenCode config; it must be an OS/network envelope around the harness. ADR 0007 (proposed, this PR) commits that envelope: a container sandbox, default-deny egress allowlisting only the gateway + GitHub + registries, and the LiteLLM gateway moved *outside* the sandbox to act as the credential-injecting egress proxy. The decisive simplification: **the spike thesis is provable entirely attended**, so this work gates only the step after the thesis — running the loop unattended, and deploying — not the spike itself. The dynamic-permission-generator idea drops to post-spike ergonomics, not a boundary.

## What the project is trying to be

Unchanged from `vision.md`: an open, self-hosted runtime for one operator's autonomous agent fleet, re-platformed off a closed harness onto OpenCode + LiteLLM, with per-persona model routing that makes cost both controllable and observable. The agent design is the asset; the harness is a commodity. The security review doesn't move that thesis — it surfaces a precondition the vision named ("runs unattended") but never priced: running an injectable cheap model unattended is only safe behind a boundary the harness does not provide.

## Where the project is

The spike is mid-flight and healthy. The gateway (AGENT-1) and OpenCode-on-LiteLLM (AGENT-3) are merged; the builder/reviewer personas + permission floor (AGENT-4, PR #13) are open and well-built — the deny-by-default bash allowlist, denied webfetch/websearch, denied secret reads, disabled share, and version floor are all real, careful work. The remaining critical path (AGENT-7 dispatch leg → AGENT-8 wake leg → AGENT-9 cost make-or-break) and the parallel de-risks (AGENT-6 fan-out, AGENT-5 attach, AGENT-2 Linear MCP) are queued.

What changed is the frame around PR #13, not its quality. The review establishes that OpenCode's permission system is UX, not a boundary; that it is bypassable several ways; and — the sharp point for us — that the SDK/API path our substrate uses may ignore `deny` rules entirely. So the careful config in PR #13 is correctly *kept* but correctly *re-weighted*: defense-in-depth for the attended/TUI path, not the control plane for the unattended/API path. The one piece of good architectural luck is that ADR 0002 already put the OpenRouter key in the gateway, out of the agent's reach — so the most valuable credential was never exposed, and the gateway is already positioned to become the egress proxy the review recommends.

## Strategic observations

1. **The config layer may be inert on our primary path — so the boundary cannot be config.** #6396 reports the SDK/API path ignoring `deny`, and the substrate (ADR 0004) is exactly an API driver. This is the single most important reframe: PR #13 is not "the safe intersection that makes unattended running safe," it is noise reduction for the attended path. Treat it as kept-but-not-load-bearing, and put the real control at the OS/network layer (ADR 0007). An empirical probe of #6396's exact scope is filed (security-track probe) to replace the "may" with a measured answer.

2. **The gateway is already the boundary; lean into it.** ADR 0002 put the OpenRouter key only in LiteLLM and gave OpenCode just a localhost master key. That accident is the recommended end-state: a gateway outside the sandbox that injects the key the agent never holds. ADR 0007 makes it deliberate — egress allowlist → gateway only for model calls, master key bounded by the hard budget cap. We get credential isolation almost for free because the architecture already half-built it. Recommendation embedded in 0007: gateway runs outside the sandbox; egress default-deny.

3. **The gate is "unattended operation," not "AGENT-7/8 construction."** This is where I'd sharpen your framing. Building the dispatch and wake legs is attended `/companion` work and exposes nothing new — and AGENT-9 (the cost make-or-break) can be *run attended* to get the number. None of G1–G4 require a standing unattended loop; G4 is a single demonstrated wake. So the envelope doesn't gate the spike at all — it gates the step *after* the verdict: leaving the proven loop running with no human, and deploying. This unblocks more than "security gates 7/8" implies: the entire thesis can be proven before the sandbox exists. Recommendation: don't block 7/8/9 on the security track; block only a named "operate unattended / deploy" gate.

4. **Container, not microVM or VM — because of the macOS bar and the actual threat.** The threat is exfiltration by an injected cheap model, which egress control + credential isolation + filesystem scoping fully address; it is not a kernel-escape adversary. A microVM is KVM-only and fails the vision's hard macOS-portability requirement; a full VM is ops weight a solo operator shouldn't carry. A single long-lived container (Podman preferred) gives every load-bearing control, ports to both targets, and preserves ADR 0004's persistent server topology. Recommendation in 0007.

5. **OpenCode's server surface is a fast-moving RCE history; make advisory-watch a standing obligation.** Two critical CVEs in early 2026 in the exact `serve`/web surface unattended running leans on, plus a maintainer posture that disclaims the permission boundary and leaves bypass issues open. ADR 0001's "pin and validate" needs teeth: watch `anomalyco/opencode` advisories, treat a serve/web advisory as a drop-everything upgrade, validate against the gates before adopting. Low ceremony — a GH watch + a documented reflex — filed as a standing security-track item.

6. **Even attended, the spike is acceptably safe today — name why, don't hand-wave it.** Attended runs on the K12 are short, human-valved, and already off the valuable credential (gateway). The residual is "an injected agent curls or pushes secrets during a glance-away." Mitigated by: the OpenRouter key being unreachable, the existing `claude-dev` OS-level account isolation, and short human-watched runs. I'd accept that for a time-boxed spike without the full envelope — but I would *not* accept it for one unattended hour. That asymmetry is the whole sequencing decision.

## Direction recommendations

**Build next:**
- **The OS/network envelope as a parallel track to the spike, not a predecessor.** Why now: the spike proves the thesis attended and the envelope is the only thing that makes the *next* phase (unattended, deploy) safe; starting it in parallel means the verdict and the safe-operation substrate land together. Unlocks: the unattended loop and any deployment. Risk of building: container/egress setup is real but bounded one-time work. Risk of not building: the moment AGENT-8's wake loop runs unattended without it, an injectable agent is being re-prompted in a loop with no valve and no egress boundary. Effort: **M** (container + egress firewall + credential/transcript containment, three atomic items).

**Deprioritize:**
- **The dynamic-permission-generator idea → post-spike, reframed as ergonomics.** Why: it generates rules our own API-path driver may ignore (#6396); it is not the boundary. It frees spike attention for the thesis. It retains value later as attended-path blast-radius reduction — keep it on the list, off the critical path.

## Recommended issues

Filed directly into the agent-harness Linear team this session (sync mirrors to GitHub), as the post-spike **security track**:

- **AGENT-10 — Probe: does the REST/SDK path enforce `permission.deny`? (#6396 scope).** Why: settles how much, if anything, the config layer buys our primary path; cheap and decision-relevant. Priority **High**. Done in the spike window (carries both `spike` and `security`).
- **AGENT-11 — Sandbox: containerize the runtime (non-root, read-only root FS, workspace-only mount, no host creds).** Why: the isolation boundary; gates unattended + deploy. Priority **High**.
- **AGENT-12 — Default-deny network egress; gateway placed outside the sandbox (allowlist: gateway + GitHub + registries + pinned DNS).** Why: the single load-bearing exfil control. Priority **High**. Blocked by AGENT-11.
- **AGENT-13 — Credential & transcript containment (OpenRouter key gateway-only; repo-scoped deploy key; transcripts on-volume).** Why: closes the credential-reach and off-box-transcript paths. Priority **High**. Blocked by AGENT-11, AGENT-12.
- **AGENT-14 — Standing: OpenCode advisory watch + version-floor discipline.** Why: the dependency has a live RCE history in our exposed surface. Priority **Medium**.
- **AGENT-15 — GATE: unattended-operation & deployment readiness.** Why: the explicit sequencing gate; blocked by AGENT-11/12/13; nothing runs unattended or deploys until it closes; the thesis (AGENT-9) is proven attended *before* it. Priority **High**.

Top 3 to action: **AGENT-11, AGENT-12, AGENT-13** — the envelope itself. AGENT-10 first if you want the #6396 answer before committing effort, but the direction holds either way.

## Recommended ADRs

- `docs/adrs/0007-security-isolation-envelope.md` — proposed, in this PR. The foundational security/isolation decision: container sandbox, default-deny egress, gateway-as-egress-proxy, credential containment, config-as-defense-in-depth-only. Sits alongside 0001/0002/0004/0006; supersedes none. Reconciliation: it affirms 0004's logical topology and narrows that ADR's "direct-host" to its real meaning ("not sandbox-per-task"); it extends 0002's gateway with a security role; it adds the standing advisory-watch ADR 0001 gestured at; it constrains 0006's attach to the trusted interface. If you read "direct-host" in 0004 as load-bearing-as-written rather than my narrowing, the clean move is a superseding 0004 — my call is alongside, because 0004's topology is unchanged and only the deployment envelope is new.

## What I'd not do

- **Don't gate the spike on the envelope.** It would stall a thesis that is provable attended, for a boundary the thesis doesn't need. Gate only unattended operation + deploy.
- **Don't rip out or distrust PR #13.** It's correct defense-in-depth and covers the attended/TUI path. Re-weight it; don't undo it.
- **Don't reach for a microVM or VM.** The macOS bar kills the microVM and the threat model doesn't justify the VM's weight.
- **Don't build the dynamic permission generator now.** It polishes a layer that isn't the boundary and may be ignored on our path.

## Open questions for the owner

- **Supersede 0004 or sit alongside?** I chose alongside (0007 affirms 0004's topology, adds the envelope). If you want "direct-host" formally retired, say so and I'll draft a superseding 0004 instead.
- **#6396 probe before or after the envelope?** It changes nothing about building the envelope; it only tells us how much the config layer was ever worth. Cheap either way — your call on ordering.
- **Is the GitHub-egress residual acceptable to you as stated?** It's the one exfil path the envelope mitigates but doesn't seal. I think repo-scoped deploy key + human-reviewed PRs is enough; flag if you want it tighter (e.g. a push-staging review step).
