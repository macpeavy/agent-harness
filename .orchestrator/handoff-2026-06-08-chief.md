# Handoff → chief (agent-harness) — 2026-06-08

You're the chief for **agent-harness** (the incumbent Claude Code chief; `/chief agent-harness`).
P2 — the chief-analogue / planning engine — is **built and merged**. The substrate is now
ready for the one thing this whole phase was building toward: the **real-feature
measurement run**. This handoff orients you to decide direction from here.

## The frame

ADR 0019's P2 core — **decompose → curate → dispatch → consume-escalations** — is complete,
behind the two owner gates. The unmeasured number that is the actual thesis verdict — the
**chief's own decomposition cost on a real multi-file feature** (the shakedown measured only
the build loop on hand-written specs) — is now measurable. That run is the headline next move
and it's a direction call: which feature, on which gateway budget.

## What shipped this session (all merged)

- **#72 — `decompose` tool.** `validateDag` (pure, Kahn's) + `PlanRepository.createDecomposition`
  (transactional batch) + `service.decompose` + the MCP tool. Per the `adding-an-mcp-tool` skill.
- **#73 — chief wired.** `litellm/chief` route (Sonnet) + opencode model + the `chief` agent
  (mode primary, `agents/chief.md`, edit/bash/task/web deny, `substrate_*` allow). MCP scoped
  per persona — builders/reviewer deny `substrate_*` (OpenCode default-allows global MCP tools).
- **#75 — conversational approval** (superseded the CLI gate #74). `dispatchReady` folds
  planning→ready, so the chief calling `dispatch` IS approving — gated behaviorally
  (`agents/chief.md`: propose → ask → dispatch only on an explicit go). Hard boundary stays the
  merge gate. Async approval deferred to the dashboard (ADR 0015).
- **#76 — escalation re-dispatch (both paths).** `tierHint` now lives end-to-end
  (`builder-strong` route+agent; `dispatch.tier` column; the build leg resolves cheap/strong).
  `promote` (escalated→strong, fresh id) + `redecompose` (escalated→`superseded` new terminal
  state; transactional edge surgery; projected-DAG validation). The deferred branch fix is
  resolved: re-dispatches get a fresh id with `issueId == dispatchId`.
- **#77 — terminal reaper.** Global idempotent sweep: done→reap sessions; failed/orphaned→reap
  branch (keep session for debug); `reapedAt` stamp; `bun run reap`. Worktrees were already
  reaped per-leg.

## Current state

- `main` clean, no open PRs. `bun test` **172 pass**, `bun run typecheck` clean.
- The chief's MCP surface (the full toolset): `decompose`, `dispatch`, `status`, `promote`,
  `redecompose` — wired in `opencode.json` (`mcp.substrate`), validated over the real stdio boot.
- Routes live in `config/litellm.yaml`: builder (Mistral), builder-nano/-gemini (alternates),
  builder-strong (Sonnet), reviewer (Sonnet), chief (Sonnet). principal/Opus is NOT yet a route.

## The headline next move — the measurement run

Stand up a real run where the **chief decomposes an actual multi-file feature**, dispatches it,
and the registry records the **chief-included blended cost** (decomposition + build + review +
amend). This is ADR 0019's "first measurement target," still open. To run it:

1. **Pick the feature** — a real multi-file agent-harness feature worth decomposing (a direction
   call; ADR 0014 says decompose pays only on multi-file work). Candidate sources: the open
   `port` issues, or a genuinely-needed substrate feature.
2. **Bring the gateway up** (it was down all this session — nothing was pinged live):
   `bash -c 'set -a; source .env; set +a; exec .venv/bin/litellm --config config/litellm.yaml --port 4000'`.
   Only `OPENROUTER_API_KEY` + `LITELLM_MASTER_KEY` are configured.
3. **Verify the chief + builder-strong routes resolve** against the live gateway
   (`scripts/verify-gateway.sh`) — neither has been pinged yet.
4. Drive the chief through `decompose` → owner-approve → `dispatch`, let the daemon run, and read
   `status` + the registry readout (`cheapAbleFraction`) for the blended number.

## Deferred / backlog (direction calls for you)

- **AGENT-27 — broader incumbent-chief abilities** (issues #58–64): memory, stewardship/ADR
  authoring, tending, producer dispatch, discovery, portfolio. The harness chief grows into
  "behaves as it does today" incrementally; until then **you (incumbent) keep doing
  agent-harness's strategy**.
- **principal / Opus A/B** (ADR 0010/0019) — add once there's real decomposition work to A/B the
  chief cost against. One litellm route + opencode model + `agents/principal.md` entry.
- **Explicit per-chunk skill curation** — `chunk.skills` doesn't exist yet; the build leg infers
  skills from `surface`. ADR 0019 open question (the chief's curation rule).
- **Build-leg tier-resolution test gap** — the cheap/strong agent pick in `runBuildLeg` isn't
  unit-tested (real git/gh); would need the same fake-injection the daemon has.
- **Reaper as a periodic job** — it's a manual `bun run reap` today; scheduling it (or folding a
  sweep into the daemon's idle tick) is a later call.
- **Dashboard (ADR 0015)** — where async (out-of-session) approval would live, with the
  un-self-approvable property a raw CLI can't hold.

## Hard-won conventions (easy to get wrong)

- **No backticks in `git commit -m`** on zsh — they command-substitute and execute. I once ran
  `bun run reap` by accident this way (reaped 0, no harm). Use `-F <file>` or plain text.
- Layering (ADR 0017): engine/repository/service/router; SQL only in a repository; **repos never
  import each other** — `PlanDispatchService` is the only binder; the daemon stays pure
  dispatch-context (never imports the plan repo).
- One shared substrate db (`.substrate/substrate.db`); cross-context links are real FKs; one
  Drizzle migration set (`bun run db:generate`). Four additive nullable columns so far
  (surface, skills, tier, reapedAt).
- OpenCode permissions are **last-match-wins** (inverse of Claude Code) and **deep-merge** agent
  over global; MCP tools are `substrate_*` (default-allow → deny on non-chief personas).
- Each slice = its own PR; **attended** — the owner approves the plan and every merge; never
  auto-merge. `gh pr edit` is broken on this repo (classic-projects GraphQL) — patch via
  `gh api -X PATCH repos/macpeavy/agent-harness/pulls/N`.

## Read first

`docs/adrs/0019` (P2 architecture), `0014` (chunk spec / tier), `0013` (model tiers), `0017`
(layering), `0018` (skills/injection). `agents/chief.md` (the harness chief's prose).
Continuity: `.orchestrator/ledger.md`. Shakedown findings: `research/2026-06-07-shakedown.md`
(cost shape ~$0.10–0.35/PR).
