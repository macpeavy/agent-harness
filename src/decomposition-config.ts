// Decomposition dials (ADR 0022) — the soft size targets the chief reads into its decompose
// reasoning, loaded from config/decomposition.yaml. A sibling to ./config.ts (the env-based
// substrate config); this one is file-based because the dials are tuned config, not deployment
// wiring. Typed + validated at the boundary (zod) — foreign YAML becomes a known shape or fails
// loudly, never a silently-wrong number.
//
// These are SOFT targets, never validators: the chief gravitates to them, using judgment. The
// granularity *invariants* (no two parallel chunks touch one file, etc.) are correctness rules
// that live in agents/chief.md, not here (ADR 0022's invariant/dial split).

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const SCHEMA = z.object({
  /** Soft size the chief aims a single chunk at (a lean, not a cap). */
  chunkTargetLines: z.number().int().positive(),
  /** Soft size of a session — the reviewable-PR unit (one PR per session, ADR 0020). */
  sessionTargetLines: z.number().int().positive(),
});

export type DecompositionConfig = z.infer<typeof SCHEMA>;

/** The seed defaults (ADR 0022 open question) — used when the config file is absent, so a
 *  missing dials file never bricks the chief; the shipped config/decomposition.yaml carries
 *  these same values, tuned later by the instrument. */
export const DEFAULT_DECOMPOSITION: DecompositionConfig = {
  chunkTargetLines: 250,
  sessionTargetLines: 1000,
};

const DEFAULT_PATH = "config/decomposition.yaml";

/**
 * Load + validate the decomposition dials. A missing file falls back to the seed defaults (the
 * dials are soft guidance, not load-bearing wiring); a present-but-malformed file throws — a
 * committed config error should fail loudly, not silently revert to a different number.
 */
export function loadDecompositionConfig(path: string = DEFAULT_PATH): DecompositionConfig {
  if (!existsSync(path)) return DEFAULT_DECOMPOSITION;
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  const result = SCHEMA.safeParse(parsed);
  if (!result.success) throw new Error(`invalid ${path}: ${result.error.message}`);
  return result.data;
}
