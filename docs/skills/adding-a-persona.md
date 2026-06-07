---
name: adding-a-persona
description: Use when adding an OpenCode persona (a new agent like chief, principal, a producer). Personas are configuration — an agent definition + a model route + a permission set — not code.
---

# Adding a persona

**When:** you're adding a new agent to the fleet — `chief`, `principal`, a reviewer
variant, a producer. Per ADR 0005 a persona is **configuration of OpenCode, not a
program**: an agent definition with a `model:` route and a `permission:` set.

**Files:** `agents/<name>.md` (the role prose), an `agent` entry in `opencode.json`
(mode + model route + permissions), and — if it needs a new route — a gateway route
(see the `adding-a-model-route` skill). Role prose ports from the incumbent design.

## How

1. **Write `agents/<name>.md`** — the role prose (ported from the incumbent persona where
   one exists). This is the system prompt; keep it in the repo, diffable.
2. **Add the `agent` entry to `opencode.json`**: `description`, `mode`
   (`subagent` for fleet workers; `all`/`primary` if the substrate dispatches it
   directly), `model` (the LiteLLM route, e.g. `litellm/chief`), `prompt`
   (`{file:./agents/<name>.md}`), and a `permission` block.
3. **Author permissions last-match-wins.** OpenCode is **last-match-wins** (the inverse
   of Claude Code) — put the broad `deny`/`ask` first, then the specific `allow`s. Give
   each persona the *least* it needs: a reviewer is `edit: deny` (read-only); a builder
   gets scoped `git`/`gh`/build bash; never loosen the deny-floor (ADR 0007).
4. **Pin the model tier to the role** (ADR 0013): chief/principal = best/strong,
   reviewer = strong, builder = cheap (or strong via route for a complex chunk).
5. **Set `task: deny` on fleet workers** — the substrate fans out, not the agent
   (the spike proved fan-out at the substrate layer, not via the experimental task tool).

## Worked example

From `opencode.json` (the reviewer — read-only, strong route):

```json
"reviewer": {
  "description": "Reviews a PR/diff on the strong route; read-only, ranked findings.",
  "mode": "subagent",
  "model": "litellm/reviewer",
  "prompt": "{file:./agents/reviewer.md}",
  "permission": { "edit": "deny", "task": "deny" }
}
```

Adding `chief`: `agents/chief.md` (ported role prose) + an `opencode.json` entry on
`litellm/chief` (Sonnet) with the chief's tool set, plus `principal` identical but on
`litellm/principal` (Opus) for the A/B (ADR 0010).
