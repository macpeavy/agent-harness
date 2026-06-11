// Owner-facing session-state language (AGENT-52) — the raw state strings are engine
// vocabulary, and `review` reads as "the reviewer persona is reviewing" when it actually
// means "build-complete, awaiting the OWNER's review/merge" (the owner hit exactly this
// ambiguity on the first run). The owner-facing surfaces (fleet pane, history) render
// through this map; engine/registry surfaces keep the raw states.

import type { SessionState } from "../substrate/plan";

const OWNER_LABELS: Partial<Record<SessionState, string>> = {
  review: "awaiting your review",
  "needs-attention": "stuck — chief routing",
};

/** The owner-facing label for a session state; states that read fine pass through. */
export function sessionStateLabel(state: SessionState): string {
  return OWNER_LABELS[state] ?? state;
}
