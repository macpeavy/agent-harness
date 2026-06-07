// Build context pack assembly (ADR 0018) — the load-bearing build knowledge the
// substrate PUSHES into the build prompt, so the builder gets the standards + the
// chunk's primary skill(s) regardless of whether it would read a pointer. The AGENT-26
// shakedown found pull is model-dependent (Mistral read the named skills; a lazier model
// might not), which is the wrong property for a swappable cheap builder (ADR 0010).
//
// Standards are always load-bearing; skills are curated from the chunk's surface (until
// the chief curates per chunk in P2, ADR 0019). Tight by design — a few load-bearing
// pieces, not the whole library (Mistral's build is already token-heavy).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ContextPackInput {
  /** The repo to read docs/standards.md + docs/skills/ from. */
  repoPath: string;
  /** The chunk's one file — drives default skill selection when `skills` isn't given. */
  surface?: string;
  /** Explicit skill names (the chief's per-chunk curation); overrides surface inference. */
  skills?: string[];
}

/**
 * The skill(s) a chunk's surface implies. `writing-tests` is always load-bearing (every
 * chunk ships a test); the rest key off the file the chunk targets.
 */
export function skillsForSurface(surface: string): string[] {
  const skills = new Set<string>(["writing-tests"]);
  if (/schema\.ts$|\.db\b|persistence/.test(surface)) skills.add("persistence-drizzle");
  if (/(^|\/)src\/opencode\//.test(surface)) skills.add("typed-api-boundary");
  if (/(^|\/)src\//.test(surface)) skills.add("adding-a-substrate-module");
  return [...skills];
}

/**
 * The load-bearing pack as injectable prompt text: docs/standards.md + the relevant
 * skill(s). Missing files are skipped (best-effort, never throws); returns "" when
 * nothing is found, so the caller can inject conditionally.
 */
export function buildContextPack(input: ContextPackInput): string {
  const skills = input.skills ?? (input.surface ? skillsForSurface(input.surface) : ["writing-tests"]);
  const sections: string[] = [];

  const standards = readDoc(input.repoPath, "docs/standards.md");
  if (standards)
    sections.push(`# Coding standards (docs/standards.md) — every change follows these\n\n${standards}`);

  for (const skill of new Set(skills)) {
    const content = readDoc(input.repoPath, join("docs/skills", `${skill}.md`));
    if (content) sections.push(`# Skill: ${skill}\n\n${content}`);
  }

  return sections.join("\n\n---\n\n");
}

function readDoc(repoPath: string, rel: string): string | null {
  const path = join(repoPath, rel);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}
