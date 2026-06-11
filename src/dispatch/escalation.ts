// The failure/escalation policy (service layer) — the single place that decides what happens
// when a chunk fails to reach `done`, and the single place that writes the escalation/failure
// transition. It encodes the ADR 0023 taxonomy in code: a failure mode maps to one handling.
//
// The invariant (ADR 0023): every RECOVERABLE non-success escalates → parks (non-terminal,
// chief-visible, with a reason). Terminal `failed` is reserved for the genuinely unrecoverable
// substrate condition (repo/worktree/DB gone) — nothing the chief can route. Before this, the
// handling was scattered across the build path (hard-fail), the review loop (escalate), and the
// timeout path — which is how park-over-fail kept getting lost. Now there is one surface; adding
// a failure mode is one case here + one row in ADR 0023.
//
// Layering (ADR 0017): this is service/policy. The actual state write stays in the repository
// (SQL only there) — this calls repo.escalate / repo.transition, it holds no SQL.

import { TRANSITIONS, type DispatchRepository, type Escalation as EscalationReason } from "../substrate/dispatch";

/** The ways a chunk fails to reach `done` — the ADR 0023 taxonomy rows 1–6. Every failure path
 *  in the daemon classifies into exactly one of these. */
export type FailureMode =
  | { kind: "no-op" } // row 1 — builder changed nothing (incl. false "Task completed")
  | { kind: "error"; message: string } // row 2 — a leg threw (worktree/install/agent)
  | { kind: "timeout"; message: string } // row 3 — model-turn timeout
  | { kind: "amend-cap" } // row 4 — review kept finding blockers past the cap (or a stuck amend)
  | { kind: "owner-note" } // row 5 — builder couldn't action an owner review note
  | { kind: "blocked"; message: string } // headless permission prompt — needs a human (ADR 0026 wake)
  | { kind: "substrate"; message: string }; // row 6 — unrecoverable (repo/DB gone)

/** How a failure is handled: park (escalate, non-terminal) for everything recoverable; terminal
 *  `failed` only for an unrecoverable substrate condition. */
export interface Handling {
  /** false → escalate→park (the common case); true → terminal `failed` (substrate-only). */
  terminal: boolean;
  /** The parked reason recorded on the dispatch (when not terminal) — chief-routable. */
  reason?: EscalationReason;
  /** Free-text detail (the error/timeout message) surfaced in `status`. */
  message?: string;
}

/**
 * The ADR 0023 taxonomy, in code — the single source of truth for failure handling.
 * Every parked mode carries a message: the modes without a caller-supplied one get a
 * default, so `escalation_reason` is never null and the chief routes on the recorded
 * cause instead of guessing (the AGENT-55 blind-routing bug — `attended` with a null
 * reason reads as anything the chief imagines).
 */
export function classifyFailure(mode: FailureMode): Handling {
  switch (mode.kind) {
    case "no-op":
      return { terminal: false, reason: "no-op", message: "builder reported done but changed nothing (empty diff, after a re-prompt)" }; // row 1 → park; redecompose / promote
    case "error":
      return { terminal: false, reason: "error", message: mode.message }; // row 2 → park to attended
    case "timeout":
      return { terminal: false, reason: "attended", message: mode.message }; // row 3
    case "amend-cap":
      return { terminal: false, reason: "re-decompose", message: "review still found blockers at the amend cap (or an amend changed nothing)" }; // row 4
    case "owner-note":
      return { terminal: false, reason: "attended", message: "builder could not action the owner's review note (the amend changed nothing)" }; // row 5
    case "blocked":
      return { terminal: false, reason: "attended", message: mode.message }; // headless permission → human
    case "substrate":
      return { terminal: true, message: mode.message }; // row 6 — the only legitimate terminal fail
  }
}

/**
 * Apply a failure's handling — the ONE function that writes an escalation/failure transition.
 * Recoverable modes escalate→park (non-terminal, chief-visible); only an unrecoverable substrate
 * condition reaches terminal `failed`. Falls back to `failed` if the dispatch's current state has
 * no escalate edge (it always should for a mid-flight failure) so a dispatch is never left stuck.
 * Returns the handling so the caller can log it. The repo owns the SQL (ADR 0017).
 */
export function escalateOrFail(repo: DispatchRepository, id: string, mode: FailureMode): Handling {
  const handling = classifyFailure(mode);
  const current = repo.get(id);
  if (!current) throw new Error(`escalateOrFail: no dispatch ${id}`);

  if (!handling.terminal && handling.reason && TRANSITIONS[current.state].includes("escalated")) {
    repo.escalate(id, handling.reason, handling.message);
  } else if (TRANSITIONS[current.state].includes("failed")) {
    repo.transition(id, "failed");
  }
  return handling;
}
