// The new-file droppings check (service layer, AGENT-53) — the deterministic backstop at
// chunk land. PR #151 shipped the builder's self-verification checklist as a repo file
// (docs/tests/claudemd-144.md, named after the work item, referenced by nothing); the
// planning and reviewer layers now steer against that, and this check catches what slips
// through anyway: a NEW file in the chunk's diff that carries the work-item fingerprint in
// its name, or that nothing else in the tree references. Pure classification — the merge
// leg gathers the inputs (added paths, id tokens, a reference probe) and annotates the
// session PR with the flags. NON-BLOCKING by design: a flag pre-highlights the owner's
// review, it never halts a land (false positives are cheap; a silent dropping is not).

export interface DroppingFlag {
  path: string;
  reason: string;
}

// Generic words that appear in nearly every id/branch and prove nothing about a filename.
const STOPWORDS = new Set([
  "feat",
  "fix",
  "chore",
  "docs",
  "doc",
  "test",
  "tests",
  "session",
  "main",
  "chunk",
  "agent",
  "src",
  "the",
  "and",
  "for",
]);

// New files that legitimately reference nothing / are referenced by nothing through their
// name: co-located bun tests (wired by the runner), generated migrations (wired by the
// drizzle journal).
function isExempt(path: string): boolean {
  return /\.test\.[a-z]+$/.test(path) || path.startsWith("drizzle/");
}

/** The distinctive words of a work-item id/branch — what a dropping's filename echoes. */
function distinctiveWords(token: string): string[] {
  return token
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * The id tokens a chunk's land knows itself by — the dispatch/issue ids and the branches,
 * with the structural prefixes stripped (`session-main-`, `agent/`). Order/duplication
 * don't matter; flagDroppings matches words.
 */
export function fingerprintTokens(...parts: (string | null | undefined)[]): string[] {
  const tokens: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    tokens.push(part.replace(/^session-main-/, "").replace(/^agent\//, ""));
  }
  return tokens;
}

/**
 * Classify a chunk's ADDED files (pure). A file is flagged when:
 *  - its path carries the work-item fingerprint — the whole id, or ≥2 of its distinctive
 *    words of which at least one is the id's NUMBER (the PR #151 dropping was
 *    `docs/tests/claudemd-144.md` for chunk `feat-144-claudemd-s1-c1`: no full-id match,
 *    but "claudemd" + "144"). The numeric requirement keeps a legitimate module from
 *    being flagged just because the chunk is named after the file it produces
 *    (`feat-201-owner-notify-s1-c1` building `owner-notify.ts` is the normal case, not
 *    a dropping — an issue number bleeding into a filename is); or
 *  - nothing else in the tree references it (`referenced` is the caller's probe — the
 *    merge leg greps the worktree for the file's name stem).
 * Exempt: co-located `*.test.*` files and `drizzle/` migrations.
 */
export function flagDroppings(
  addedPaths: string[],
  idTokens: string[],
  referenced: (path: string) => boolean,
): DroppingFlag[] {
  const tokens = idTokens.map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
  const words = new Set(idTokens.flatMap(distinctiveWords));

  const flags: DroppingFlag[] = [];
  for (const path of addedPaths) {
    if (isExempt(path)) continue;
    const lower = path.toLowerCase();

    const wholeId = tokens.some((t) => lower.includes(t));
    const echoes = distinctiveWords(lower).filter((w) => words.has(w));
    const numericEcho = echoes.some((w) => /^\d+$/.test(w));
    if (wholeId || (echoes.length >= 2 && numericEcho)) {
      flags.push({ path, reason: "named after the work item (builder-dropping fingerprint)" });
      continue;
    }
    if (!referenced(path)) {
      flags.push({ path, reason: "new file with no inbound reference anywhere in the tree" });
    }
  }
  return flags;
}
