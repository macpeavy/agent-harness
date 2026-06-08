// The decompose context (ADR 0022) — the soft size dials rendered as the guidance the chief
// reads when it decomposes. The build counterpart of context-pack.ts (which pushes standards +
// skills into a BUILD): this surfaces the decomposition dials into the chief's DECOMPOSE path,
// by riding in the meta_decompose / decompose tool descriptions the chief reads before it calls
// them. Single source: the numbers come from config/decomposition.yaml, never restated in the
// persona or standards.md — so they can't re-drift (the bug ADR 0022 fixes).

import type { DecompositionConfig } from "../decomposition-config";

/**
 * The chunk-size guidance line, from the dials. Names the dial so the chief knows it's tunable
 * config, frames it as a soft lean (not a cap), and points at the invariant that is NOT a number
 * (so the chief never re-derives "one file per chunk" from the size target).
 */
export function chunkGuidance(cfg: DecompositionConfig): string {
  return (
    `Soft size target (config/decomposition.yaml, a lean — not a cap; use judgment): aim each ` +
    `chunk at ~${cfg.chunkTargetLines} lines (chunkTargetLines). Size is a dial; the hard rule is ` +
    `the invariant — no two parallel chunks touch the same file — so a one-line shared touch rides ` +
    `with its consumer, it does not become its own chunk.`
  );
}

/** The session-size guidance line, from the dials (the reviewable-PR target, ADR 0020). */
export function sessionGuidance(cfg: DecompositionConfig): string {
  return (
    `Soft size target (config/decomposition.yaml, a lean — not a cap): aim each session at ` +
    `~${cfg.sessionTargetLines} lines (sessionTargetLines) — one reviewable PR. A small feature is ` +
    `one session; a large one is several.`
  );
}
