import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseGhRepo } from "./config";

describe("parseGhRepo", () => {
  it("parses an ssh remote", () => {
    expect(parseGhRepo("git@github.com:macpeavy/agent-harness.git")).toBe("macpeavy/agent-harness");
  });

  it("parses an https remote with .git", () => {
    expect(parseGhRepo("https://github.com/macpeavy/agent-harness.git")).toBe(
      "macpeavy/agent-harness",
    );
  });

  it("parses an https remote without .git or trailing slash", () => {
    expect(parseGhRepo("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(parseGhRepo("https://github.com/acme/widgets/")).toBe("acme/widgets");
  });

  it("returns null on a URL it can't parse", () => {
    expect(parseGhRepo("not-a-remote")).toBeNull();
  });
});

describe("loadConfig", () => {
  // loadConfig reads process.env; snapshot and restore the keys it touches.
  const KEYS = [
    "AH_REPO",
    "AH_GH_REPO",
    "AH_WORKTREE_ROOT",
    "AH_BUILDER_AGENT",
    "AH_REVIEWER_AGENT",
    "AH_AMEND_CAP",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("applies defaults (gh repo pinned via env to skip remote derivation)", async () => {
    process.env.AH_GH_REPO = "acme/widgets";
    const config = await loadConfig();

    expect(config.repoPath).toBe(process.cwd());
    expect(config.ghRepo).toBe("acme/widgets");
    expect(config.worktreeRoot).toBe(join(tmpdir(), "ah-worktrees"));
    expect(config.builderAgent).toBe("builder");
    expect(config.reviewerAgent).toBe("reviewer");
    expect(config.amendCap).toBe(3);
  });

  it("honors every override", async () => {
    process.env.AH_REPO = "/srv/repo";
    process.env.AH_GH_REPO = "acme/widgets";
    process.env.AH_WORKTREE_ROOT = "/srv/worktrees";
    process.env.AH_BUILDER_AGENT = "builder-alt";
    process.env.AH_REVIEWER_AGENT = "principal";
    process.env.AH_AMEND_CAP = "5";
    const config = await loadConfig();

    expect(config).toEqual({
      repoPath: "/srv/repo",
      ghRepo: "acme/widgets",
      worktreeRoot: "/srv/worktrees",
      builderAgent: "builder-alt",
      reviewerAgent: "principal",
      amendCap: 5,
    });
  });

  it("falls back to the default cap on a malformed AH_AMEND_CAP", async () => {
    process.env.AH_GH_REPO = "acme/widgets";
    process.env.AH_AMEND_CAP = "not-a-number";
    expect((await loadConfig()).amendCap).toBe(3);
  });
});
