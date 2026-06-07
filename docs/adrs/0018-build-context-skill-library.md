# 0018 — Build context: a harness-neutral skill library, guaranteed-injected

- **Status:** proposed
- **Date:** 2026-06-07
- **Refines:** 0005 (the "OpenCode skills" mechanism), 0010 / 0014 (the chunk context pack), and closes the AGENT-25 skill-delivery residual.

## Context

The build-phase skills (AGENT-24/25) shipped under `.claude/skills/` in the portable
Agent-Skills format. Two things surfaced:

1. **Location is incongruous.** `.claude/` is Claude Code's convention; agent-harness is
   built on OpenCode, and the skills are consumed by the OpenCode build fleet (and,
   later, the chief). Housing them under a *Claude-Code* magic directory implies a
   harness-native skill-discovery mechanism we do not use — and it's the wrong vendor's
   directory for an OpenCode-native project.
2. **Delivery is pull, not push.** The AGENT-26 shakedown verified (in OpenCode logs)
   that the Mistral builder *read* `docs/standards.md` and the named skills — but only
   because the chunk spec *pointed* at them and the model chose to follow the pointer.
   There is no guaranteed-injection mechanism (unlike the incumbent CC orchestrator's
   `required_skills`). Pull worked for Mistral; it is **model-dependent**, which is
   exactly the wrong property for a deliberately cheap, *swappable* builder (ADR 0010) —
   swap the model and build quality can silently degrade because the new model doesn't
   read the pointer.

These are two facets of one question: what *are* these skills, where do they live, and
how does build context actually reach the builder.

## Decision

**The skills are a harness-neutral curated build-knowledge library — ours — not
harness-native auto-discovered skills.**

1. **Relocate `.claude/skills/` → `docs/skills/`.** They sit beside `docs/standards.md`
   as project documentation, signalling "ours, harness-agnostic," not a Claude-Code or
   OpenCode native skill directory. (We do not rely on either harness's native
   skill-discovery; ADR 0005's "OpenCode skills" line is refined accordingly — the
   mechanism is ours, the format stays portable so a harness's native loader *could*
   read them if ever useful, e.g. the chief/attended path.)

2. **Delivery is guaranteed injection of the load-bearing pack, not pull.** The
   substrate **pushes** the load-bearing context — `docs/standards.md` plus the chunk's
   primary skill(s) — directly into the build prompt, so it is present regardless of
   whether the builder would have chosen to read a pointer. Pointers to the wider
   library remain in the spec as a *supplement* (pull for the model that reads more),
   never as the guarantee. This matches the CC orchestrator's `required_skills`
   guarantee and makes build quality robust to a builder swap — the load-bearing
   property for the model-agnostic spine.

3. **The chief curates the pack per chunk (P2).** Which skill(s) and which slice of the
   standards are load-bearing for a given chunk is a chief/decomposition decision (ADR
   0010 / 0014's context pack). Curate **tightly** — the shakedown showed Mistral's
   build is already token-heavy (~$0.03–0.15, it reads a lot of context), so inject the
   relevant pieces, not the whole library. Until the chief exists, the build/dispatch
   leg injects a sensible default pack (standards + the skills the chunk's surface
   implies).

## Consequences

- Build quality no longer depends on the builder *choosing* to read pointers — it is
  guaranteed for the load-bearing pack, so swapping the cheap model can't silently drop
  the standards. Directly serves the model-agnostic ethos.
- A modest, bounded token cost on every build (the injected pack), held down by tight
  per-chunk curation rather than injecting everything.
- The skill library is harness-neutral and lives with the docs; references in
  `CLAUDE.md` and `docs/standards.md` are updated. (Prior ADRs 0016/0017 and the
  shakedown research notes reference the old `.claude/skills/` path as a point-in-time
  record; this ADR is the relocation of record.)
- Closes the AGENT-25 residual (skill delivery) and gives P2/AGENT-21 a settled rule:
  the chief curates and the substrate guarantee-injects.

## Alternatives considered

- **Keep `.claude/skills/`.** Rejected — Claude-Code's directory in an OpenCode-native
  project, implying a discovery mechanism we don't use.
- **Move to `.opencode/skills/`.** Rejected — same category error in the other vendor's
  direction; it implies OpenCode's native skill loader, which we deliberately do not
  depend on (ADR 0005 flagged it under-verified; the shakedown confirmed we drive
  context ourselves). The library is ours, not the harness's.
- **Keep pull-only (just curate good pointers).** Rejected — it worked for Mistral but
  is model-dependent; it makes build quality a property of *which* cheap model is routed,
  undermining the swappable-builder design.
- **Inject the whole library every build.** Rejected — needless tokens on an
  already-token-heavy build; tight per-chunk curation is the point.

## Implementation notes (AGENT-21)

- **Injection format:** a context section is prepended to the build prompt — `docs/standards.md`
  then each curated skill, `---`-separated, ahead of the issue (`src/dispatch/context-pack.ts`
  → `buildContextPack`, pushed by `src/dispatch/legs/build.ts`'s `buildPrompt`). The build
  leg reads the docs from the repo and injects their content, so the guarantee holds
  regardless of the model reading pointers.
- **Curation is rule-based by default, reasoned-override-ready.** `skillsForSurface` maps the
  chunk's surface → skills (writing-tests always; persistence-drizzle for schema/db,
  typed-api-boundary for opencode, adding-a-substrate-module for any src module). The
  chief's per-chunk reasoned curation rides over it via an explicit `skills` list. With no
  surface (the current daemon path, pre-plan-wiring), the pack is standards + writing-tests.
- **Pending:** the chunk's `surface`/`skills` flow into the build only once the plan→dispatch
  wiring carries them (the next slice); until then the default pack ships on every build.

## Open questions

- The token budget per pack as the library grows — tuned against the shakedown's cost
  shape (~$0.10–0.35/PR); curate tightly (inject the load-bearing pieces, not everything).
