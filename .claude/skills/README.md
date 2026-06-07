# Skills — build-phase operational guides

Each skill operationalizes a recurring "how do I add X" surface in this repo. Load the
matching skill when you do that kind of work; they pair with `docs/standards.md` (the
rulebook) and the ADRs (the decisions). They're written for the build phase — the cheap
builder leans on them more than a strong model would.

| Skill | When |
|---|---|
| `adding-a-substrate-module` | Adding a new `src/` module — a dispatch leg, wake driver, github helper, registry. |
| `typed-api-boundary` | Calling a foreign JSON API (OpenCode server, GitHub) — safe typing without `any`. |
| `persistence-drizzle` | Adding durable state (the dispatch registry, any store) — Drizzle over bun:sqlite. Pairs ADR 0009 + 0016. |
| `adding-a-persona` | Adding an OpenCode agent (chief, principal, a producer) — config, not code. Pairs ADR 0005/0010. |
| `adding-a-model-route` | Wiring a model — a LiteLLM route + the matching `opencode.json` entry. Pairs ADR 0002. |
| `writing-tests` | Tests for a module — `bun:test`, co-located, one behavior per case. |
| `opening-a-pr` | Commit/PR conventions + the substrate-owns-git boundary. |

These grow with the system: when a new heavyweight surface appears, it ships with a
paired ADR + skill (the architectural-defaults convention).
