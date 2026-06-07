# Strategy journal — agent-harness

Append-only chief audit trail: what was considered, close calls, predictions to track. The owner does not react on this (unlike Linear / direction artifacts).

## 2026-06-07 — port planning, post-spike greenlight

The synthesis that organized the whole port: the cheap-able fraction is *manufactured by decomposition*, not found — which makes the chief (the decomposer) the cost engine and ties calls #2/#3/#4/#5 into one spine (planner → cheap build → review+amend → merge, registry as the measurement backbone). Filed as ADRs 0008–0011 + `roadmap.md`.

Three owner calls reshaped my drafts:
- Chief-analogue is the chief *as it behaves today* (direction + Linear + ADRs + skills, attended) — I had over-stripped it to a bare decomposer. Corrected in 0010.
- Orchestrator (`/orchestrate` auto-merge) is out of favor; fleet + chief-dispatch is the shape (0011). This moves the security envelope off the near-term critical path — a real de-risking of sequencing.
- DeepSeek dropped on *provenance* (not just residency); real Western alternative wanted, Mistral leading. The tool-calling-through-the-stack bar is the gate; the probe is a real blocker on the build tier before P2 leans on it at volume.

Output-norm shift logged: owner doesn't read long briefs, reads artifacts. Retiring the long-form brief; `roadmap.md` + ADRs + Linear are the vehicle. Baked into the chief-analogue port spec (0010 decision 3).

Prediction to track: whether two tiers hold, or the registry instrument (0009) shows a mid tier pays for heavy-but-patterned work. And whether re-decompose or tier-promote is the right first escalation rung (0008) — both measured at P4.
