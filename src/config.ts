// Substrate configuration — the one place the paths, repo, worktree root, and route
// names used to be hardcoded across the legs. Resolved from the environment with
// sensible defaults; the GitHub repo is derived from the git remote when not pinned,
// so the substrate works against whatever repo it's pointed at. The daemon loads this
// once at startup and threads it into the legs — the service layer reads config, it
// does not reach for process.env (ADR 0017).

import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SubstrateConfig {
  /** Local git repo root the substrate builds in. */
  repoPath: string;
  /** GitHub `owner/name` for gh operations. */
  ghRepo: string;
  /** Base directory for per-dispatch worktrees. */
  worktreeRoot: string;
  /** OpenCode agent that runs builds (cheap route). Doubles as the cost-route key. */
  builderAgent: string;
  /** OpenCode agent that runs strong-tier builds — the builder persona on the strong
   *  route (ADR 0013/0014), for a tier-hinted or tier-promoted chunk. */
  builderStrongAgent: string;
  /** OpenCode agent that runs reviews (strong route). Doubles as the cost-route key. */
  reviewerAgent: string;
  /** Max amend rounds before a dispatch escalates (ADR 0008). Default 3. */
  amendCap: number;
}

// A positive integer from env, or the fallback (a malformed value doesn't silently
// become NaN and break the cap comparison).
function intFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Parse `owner/name` out of a git remote URL — ssh (`git@github.com:owner/name.git`)
 * or https (`https://github.com/owner/name`). Returns null if it doesn't match.
 */
export function parseGhRepo(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const match = cleaned.match(/[:/]([^/:]+\/[^/:]+)$/);
  return match ? (match[1] ?? null) : null;
}

async function deriveGhRepo(repoPath: string): Promise<string> {
  const url = (await $`git -C ${repoPath} remote get-url origin`.text()).trim();
  const repo = parseGhRepo(url);
  if (!repo) throw new Error(`loadConfig: cannot parse owner/name from git remote '${url}'`);
  return repo;
}

/** Resolve substrate config from the environment, deriving the gh repo when unset. */
export async function loadConfig(): Promise<SubstrateConfig> {
  const repoPath = process.env.AH_REPO ?? process.cwd();
  const ghRepo = process.env.AH_GH_REPO ?? (await deriveGhRepo(repoPath));

  return {
    repoPath,
    ghRepo,
    worktreeRoot: process.env.AH_WORKTREE_ROOT ?? join(tmpdir(), "ah-worktrees"),
    builderAgent: process.env.AH_BUILDER_AGENT ?? "builder",
    builderStrongAgent: process.env.AH_BUILDER_STRONG_AGENT ?? "builder-strong",
    reviewerAgent: process.env.AH_REVIEWER_AGENT ?? "reviewer",
    amendCap: intFromEnv(process.env.AH_AMEND_CAP, 3),
  };
}
