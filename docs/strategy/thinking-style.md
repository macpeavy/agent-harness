# Thinking style — how the owner reasons about agent-harness

Short, predictive bullets. Seeded on the first stewardship read (2026-06-06); appended over time. The owner edits directly when a read is wrong.

- **Reasons about stack coherence and runtime parity, not per-tool familiarity.** Flag a harness-internals fact (OpenCode is TS/Bun) and they immediately draw the implication (substrate should be TS, fewer runtimes). Predict they'll favor fewer moving parts elsewhere too.
- **Rejects throwaway/POC framing.** Every spike artifact must be a real seed of the production thing — "do not build a throwaway POC we can't build upon." Don't propose disposable scaffolding.
- **Reads non-goals and boundaries literally and catches imprecise framing.** Don't use a domain noun ("agent") in a non-goal that's about a layer boundary; name the boundary concretely (harness/runtime vs orchestration). Keep boundary statements sharp.
- **Defines the port surface by what the open harness must PROVIDE, not by what the incumbent happens to use today.** A mechanism the current stack doesn't exercise (hooks) can still be required. Don't dismiss a capability as unused.
- **Sets the bet's denominators himself; doesn't want them guessed.** The cost proxy (cost-per-mergeable-PR) and volume (~80–100 PRs/mo) are owner-set. Bring measurement, not invented numbers.
- **Sequences by blast radius and trust model.** Attended vs unattended is a real line for him; he gates the dangerous phase, not the construction. Expect him to accept sharpening a gate's exact line if the reasoning lands.
