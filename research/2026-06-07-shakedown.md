# Measurement shakedown — first integrated P1 run on the real builder (AGENT-26)

**Date:** 2026-06-07 · **Builder:** Mistral Small 4 (`mistral-small-2603`, AGENT-17 pick) · **Reviewer:** claude-sonnet-4.6

Three hand-decomposed one-file chunks (specs in `research/2026-06-07-shakedown/specs/`, written per ADR 0014 — chief played manually) driven through the P1 loop (AGENT-18 registry instrument + AGENT-19 daemon + AGENT-20 amend cycle). Aims: first end-to-end run of the integrated spine on the real builder; first cheap-able-fraction data; learn the decomposition bar by hand for the P2 chief.

## The headline: the integrated run caught a spine bug

First pass escalated SHAKE-1 *spuriously* at $0.24. Root cause: the **reviewer was omitting the mandatory `VERDICT:` line** (it lived only in the persona/system prompt), so `parseVerdict` hit its safe default (`blocking`) on a **clean** review → amended clean code → no-change → escalated. The escalation/no-change logic worked *correctly* given a wrongly-blocking verdict; the bug was upstream, in verdict emission. **Fixed in PR #52** (reinforce the verdict in the review leg's task prompt, not just the persona). The numbers below are the clean re-run on the fix.

This is the shakedown earning its keep — a process bug that would have silently tanked the cheap-able fraction at volume, caught before P2 leans on the loop.

## Results (clean re-run)

| Chunk | Outcome | Amends | Build | Review | Amend | Total | Wall | PR |
|---|---|---|---|---|---|---|---|---|
| SHAKE-1 — cheap-able-fraction readout | done | 1 | $0.148 | $0.176 | $0.014 | **$0.337** | 190s | #53 |
| SHAKE-2 — display format helpers | done | 0 | $0.029 | $0.056 | — | **$0.085** | 41s | #54 |
| SHAKE-3 — `harness status` renderer | done | 0 | $0.092 | $0.061 | — | **$0.153** | 85s | #55 |

- **Cheap-able fraction: 3/3 = 1.00** (all reached merge-ready within the amend cap).
- **Blended cost / ready PR: $0.19** (total spend $0.575) — **~2× the DeepSeek-era ~$0.09 toy baseline**, still ~15× under the $2.80 budget.

## Qualitative — where Mistral struggled, and the decomposition bar

**Difficulty prediction was inverted, and that's the lesson.** I bet the *status renderer* (alignment, null/empty edges) would draw an amend and the *readout* would one-shot. The opposite:

- **status + format one-shotted** — because the specs pre-resolved every formatting / null / empty-list decision. **Pinning the design ⇒ mechanical typing ⇒ one-shot**, even for a fiddly render.
- **readout drew the amend — a real Major correctness bug, not a nit.** Mistral counted in-flight states into the *terminal* denominator (`inFlight++` in the wrong branch), which would have inflated `cheapAbleFraction`. Sonnet caught it (`VERDICT: blocking`); the amend fixed it; `VERDICT: clean` → done.

**The bar for the P2 chief:** the chief can pre-resolve *design ambiguity* (interfaces, data shapes, formatting rules) and that buys one-shots on mechanical chunks — but it **cannot pre-resolve logic correctness**. A chunk with genuine conditional logic (counting semantics, state classification) will still route a slip through review→amend regardless of spec quality. So: spec to kill design ambiguity, and budget ~1 amend for logic-heavy chunks as the *expected* path, not a failure.

**Failure profile ≈ DeepSeek.** Strong first draft + one real correctness slip the strong reviewer catches + a clean amend — the same shape as DeepSeek's heavy build (#28's atomicity gap). Not a tool-calling failure (that was qwen). Cheap-build / strong-review / amend holds on the Western builder.

**Cost shape.** Mistral's build is **token-heavy and highly variable** ($0.029–$0.148, driven by how much context it reads before writing), and **Sonnet review is co-dominant** ($0.056–$0.176, ~doubling on a re-review). The blended $0.19/PR is honest and well under budget, but it is 2× the toy estimate — and the chief-decomposition cost is *on top* (not measured here; specs were hand-written).

## Context pack: pull worked, but the spine doesn't push

The specs curated a context pack (per ADR 0014: "read these first" — `docs/standards.md` + the relevant `.claude/skills/` skill), explicitly so we wouldn't rely on auto-load. **The spine has no skill-injection mechanism** — it sends the spec text and the builder reads files from its worktree (a repo checkout). That **pull worked this run**, verified in the OpenCode session logs: the builder issued `read` tool-calls on `docs/standards.md` (permission-allowed, file opened) and on the `writing-tests` + `adding-a-substrate-module` skills — exactly the pack each spec named, and nothing it didn't (`persistence-drizzle`: 0 reads, correct — no chunk touched persistence). The builds followed those conventions (co-located tests, explicit return types), so the pull was not just read but applied.

But pull is **model-dependent** — Mistral was diligent; a lazier builder could skip the pack and the spine would not force it. This differs from the Claude-Code orchestrator, which **injects** `required_skills` into the builder's context (push). If guaranteed delivery matters, the enhancement is to inject the pack's *content* into the build prompt, not just name the files. Flagging for the P2 chief / spine roadmap.

## Caveats

- n = 3, single run; per-chunk cost variance is large (one run is a point, not a distribution).
- The chief-design cost is unmeasured (I hand-wrote the specs) — the ADR 0014 cost reckoning (decompose-vs-direct) needs the real chief to measure.
- Cheap-able fraction 1.00 is on *well-specified* chunks; under-specified or harder chunks will lower it (the instrument measures that as escalation rate).

## For the P2 chief design (ADR 0010 / 0014)

- Pre-resolving design ambiguity demonstrably buys one-shots; logic correctness is the residual the amend cycle absorbs (~1 round).
- Budget the loop at ~$0.10–0.35/PR on this builder/reviewer pair (review-dominated), not the $0.09 toy figure.
- The decompose-vs-direct threshold and the chief-cost-per-chunk are the next things to measure, with a real chief decomposing a real multi-file feature.
