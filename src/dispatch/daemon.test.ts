import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchDaemon, type DispatchLegs } from "./daemon";
import { dispatchBranch, type BuildResult, type Issue } from "./legs/build";
import type { ReviewResult, ReviewTarget, ReviewVerdict } from "./legs/review";
import type { AmendResult } from "./legs/amend";
import type { MergeResult, MergeTarget } from "./legs/merge";
import type { SubstrateConfig } from "../config";
import { DispatchRepository } from "../substrate/dispatch";
import { AgentBlockedError, AgentTimeoutError } from "../opencode/client";

const CONFIG: SubstrateConfig = {
  repoPath: "/repo",
  ghRepo: "acme/widgets",
  worktreeRoot: "/tmp/ah-test-wt",
  builderAgent: "builder",
  builderStrongAgent: "builder-strong",
  reviewerAgent: "reviewer",
  amendCap: 3,
  agentIdleMs: 120_000,
  agentTimeoutMs: 1_800_000,
  prPollMs: 60_000,
};

const ISSUE: Issue = { id: "ISSUE-1", title: "Add a thing", body: "Do the thing." };

// A deterministic stand-in for the LiteLLM spend ledger (ADR 0026): every leg's window
// reconciles to a fixed per-route cost, so the daemon's real-cost recording is exercised
// without a live gateway/ledger. Routes mirror the fake legs (builder / reviewer).
const FAKE_COST: Record<string, number> = { builder: 0.01, "builder-strong": 0.05, reviewer: 0.03 };
const fakeReconcile = (route: string): number => FAKE_COST[route] ?? 0;

let dir: string;
let repo: DispatchRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-daemon-"));
  repo = new DispatchRepository(join(dir, "dispatches.db"));
});

afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

// Enqueue a dispatch the way the (future) enqueuer would — branch derived the same way
// the build leg derives it, so the review leg reviews the branch on record.
function enqueue(id: string, issue: Issue = ISSUE): void {
  repo.create({
    id,
    issueId: issue.id,
    title: issue.title,
    branch: dispatchBranch(issue),
    spec: issue.body,
  });
}

interface Recorder {
  build: Issue[];
  review: ReviewTarget[];
  amend: { target: ReviewTarget; findings: string }[];
  merge: MergeTarget[];
}

// Fake legs that record their calls and return canned results. `reviewVerdicts` is
// consumed in order (then defaults to "clean"); `buildThrowsFor` makes a build throw.
function fakeLegs(
  opts: {
    buildThrowsFor?: string;
    changed?: boolean;
    reviewVerdicts?: ReviewVerdict[];
    amendChanges?: boolean;
  } = {},
): { legs: DispatchLegs; rec: Recorder } {
  const rec: Recorder = { build: [], review: [], amend: [], merge: [] };
  const verdicts = [...(opts.reviewVerdicts ?? [])];
  const changed = opts.changed ?? true;
  const legs: DispatchLegs = {
    async build(issue) {
      rec.build.push(issue);
      if (opts.buildThrowsFor && issue.id === opts.buildThrowsFor) {
        throw new Error("build boom");
      }
      const result: BuildResult = {
        branch: dispatchBranch(issue),
        worktree: "/tmp/wt",
        changed,
        reply: "built",
        route: "builder",
        buildSessionId: "ses_build",
        tokens: { input: 1000, output: 500 },
      };
      return result;
    },
    async review(target) {
      rec.review.push(target);
      const result: ReviewResult = {
        branch: target.branch,
        review: "the findings",
        verdict: verdicts.shift() ?? "clean",
        waitedMs: 10,
        route: "reviewer",
        reviewSessionId: "ses_review",
        tokens: { input: 2000, output: 800 },
      };
      return result;
    },
    async amend(target, findings) {
      rec.amend.push({ target, findings });
      const result: AmendResult = {
        changed: opts.amendChanges ?? true,
        reply: "amended",
        route: "builder",
        tokens: { input: 300, output: 150 },
      };
      return result;
    },
    async merge(target) {
      rec.merge.push(target);
      const result: MergeResult = { merged: true };
      return result;
    },
  };
  return { legs, rec };
}

describe("the happy path", () => {
  it("drives a queued dispatch build → review → done, recording the instrument", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs();
    const daemon = new DispatchDaemon(repo, CONFIG, legs, fakeReconcile);

    const driven = await daemon.runOnce();

    expect(driven).toBe(1);
    const d = repo.get("d1");
    expect(d?.state).toBe("done");
    expect(d?.buildSessionId).toBe("ses_build");
    expect(d?.reviewSessionId).toBe("ses_review");
    expect(d?.route).toBe("builder");
    expect(d?.buildCostUsd).toBeGreaterThan(0);
    expect(d?.reviewCostUsd).toBeGreaterThan(0);

    expect(rec.build).toHaveLength(1);
    expect(rec.review).toHaveLength(1);
    expect(rec.review[0]?.branch).toBe(dispatchBranch(ISSUE));
  });

  it("builds from the dispatch's stored spec", async () => {
    enqueue("d1", { id: "ISSUE-9", title: "Custom", body: "the exact spec" });
    const { legs, rec } = fakeLegs();
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(rec.build[0]?.body).toBe("the exact spec");
    expect(rec.build[0]?.id).toBe("ISSUE-9");
  });
});

describe("curation passthrough (ADR 0018/0019)", () => {
  it("reconstructs the build Issue with the row's surface + curated skills", async () => {
    // The service persists curation on the row; the daemon must hand it to the build leg
    // (which injects the matching context pack) — and it survives a resume, since the
    // Issue is rebuilt from the row each time.
    repo.create({
      id: "d1",
      issueId: "ISSUE-1",
      title: "Add a thing",
      branch: dispatchBranch(ISSUE),
      spec: "Do the thing.",
      surface: "src/substrate/dispatch/schema.ts",
      skills: ["persistence-drizzle", "writing-tests"],
    });
    const { legs, rec } = fakeLegs();
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(rec.build[0]?.surface).toBe("src/substrate/dispatch/schema.ts");
    expect(rec.build[0]?.skills).toEqual(["persistence-drizzle", "writing-tests"]); // JSON round-trip
  });

  it("leaves surface/skills undefined when the row carries none (standards-only fallback)", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs();
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(rec.build[0]?.surface).toBeUndefined(); // null column → undefined, not null
    expect(rec.build[0]?.skills).toBeUndefined();
  });

  it("hands the row's build tier to the build leg (so a strong chunk routes strong)", async () => {
    repo.create({
      id: "d1",
      issueId: "ISSUE-1",
      title: "Gnarly",
      branch: dispatchBranch(ISSUE),
      spec: "Hard logic.",
      tier: "strong",
    });
    const { legs, rec } = fakeLegs();
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(rec.build[0]?.tier).toBe("strong"); // the build leg resolves this → builderStrongAgent
  });
});

describe("build that changes nothing (no-op, ADR 0023 row 1)", () => {
  it("re-prompts ONCE, then parks (reason no-op) — never terminal failed, never reaches review", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs({ changed: false }); // every build is a no-op
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    const d = repo.get("d1");
    expect(d?.state).toBe("escalated"); // parked, NOT failed
    expect(d?.escalated).toBe("no-op");
    expect(rec.build).toHaveLength(2); // initial + one re-prompt, then it gives up
    expect(rec.review).toHaveLength(0);
  });

  it("the re-prompt rescues a no-op that then writes the change", async () => {
    enqueue("d1");
    // First build no-ops; the re-prompt build changes something → proceeds normally.
    const { legs, rec } = fakeLegs();
    let calls = 0;
    legs.build = async (issue) => {
      calls++;
      return {
        branch: dispatchBranch(issue),
        worktree: "/tmp/wt",
        changed: calls > 1, // no-op first, real on the re-prompt
        reply: "ok",
        route: "builder",
        buildSessionId: "ses",
        tokens: { input: 10, output: 5 },
      };
    };
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(calls).toBe(2);
    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.review).toHaveLength(1);
  });
});

describe("crash recovery", () => {
  it("resumes a building dispatch by re-running the build", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    const { legs, rec } = fakeLegs();

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.build).toHaveLength(1);
  });

  it("resumes a review dispatch by re-running only the review, on the stored branch", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    repo.transition("d1", "review");
    const { legs, rec } = fakeLegs();

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.build).toHaveLength(0);
    expect(rec.review).toHaveLength(1);
    expect(rec.review[0]?.branch).toBe(dispatchBranch(ISSUE));
  });
});

describe("session-main merge (ADR 0020)", () => {
  it("squash-merges a cleanly-reviewed chunk into its session-main branch", async () => {
    repo.create({
      id: "d1",
      issueId: "ISSUE-1",
      title: "Add a thing",
      branch: dispatchBranch(ISSUE),
      spec: "Do the thing.",
      sessionBranch: "session-main-S1",
    });
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["clean"] });
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.merge).toHaveLength(1);
    expect(rec.merge[0]).toMatchObject({ branch: dispatchBranch(ISSUE), sessionBranch: "session-main-S1" });
  });

  it("does not merge when the dispatch has no session-main branch (legacy build-off-main)", async () => {
    enqueue("d1"); // no sessionBranch
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["clean"] });
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.merge).toHaveLength(0);
  });

  it("only merges on a clean review, not while blocking/amending", async () => {
    repo.create({
      id: "d1",
      issueId: "ISSUE-1",
      title: "Add a thing",
      branch: dispatchBranch(ISSUE),
      spec: "Do the thing.",
      sessionBranch: "session-main-S1",
    });
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["blocking", "clean"] });
    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(rec.merge).toHaveLength(1); // once, after the clean re-review — not on the blocking pass
  });
});

describe("parked dispatches", () => {
  it("does not run an escalated dispatch — it waits to be rewoken", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    repo.escalate("d1", "attended");
    const { legs, rec } = fakeLegs();

    const driven = await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(driven).toBe(0);
    expect(repo.get("d1")?.state).toBe("escalated");
    expect(rec.build).toHaveLength(0);
    expect(rec.review).toHaveLength(0);
  });
});

describe("build timeout (ADR 0020 robustness)", () => {
  it("escalates a build timeout (parked, attended) with the reason — not a terminal fail", async () => {
    enqueue("d1");
    // A leg set whose build times out instead of returning.
    const { legs } = fakeLegs();
    legs.build = async () => {
      throw new AgentTimeoutError("ses_build", 120_000, "idle");
    };

    const driven = await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(driven).toBe(1); // handled, the loop survived
    const d = repo.get("d1");
    expect(d?.state).toBe("escalated"); // parked for the chief, not failed
    expect(d?.escalated).toBe("attended");
    expect(d?.escalationReason).toContain("no activity for 120000ms"); // the recorded idle reason
  });

  it("escalates a headless permission block (parked, attended) with what it asked for — ADR 0026", async () => {
    enqueue("d1");
    const { legs } = fakeLegs();
    legs.build = async () => {
      throw new AgentBlockedError("ses_build", "bash: rm -rf /tmp/x");
    };

    const driven = await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(driven).toBe(1);
    const d = repo.get("d1");
    expect(d?.state).toBe("escalated"); // parked, not a generic leg error or terminal fail
    expect(d?.escalated).toBe("attended"); // honest reason — needs a human, not a re-prompt
    expect(d?.escalationReason).toContain("permission"); // the recorded block reason
  });
});

describe("fault isolation (leg error, ADR 0023 row 2)", () => {
  it("parks the dispatch whose build throws (reason error) and still drives the others", async () => {
    enqueue("bad", { id: "BAD", title: "Breaks", body: "boom" });
    enqueue("good", { id: "GOOD", title: "Works", body: "fine" });
    const { legs } = fakeLegs({ buildThrowsFor: "BAD" });

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    const bad = repo.get("bad");
    expect(bad?.state).toBe("escalated"); // parked, NOT terminal failed
    expect(bad?.escalated).toBe("error");
    expect(bad?.escalationReason).toContain("build boom"); // the leg's message, surfaced
    expect(repo.get("good")?.state).toBe("done"); // the loop survived and drove the other
  });
});

describe("the amend cycle", () => {
  it("a clean review goes straight to done — no amend round", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["clean"] });

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(repo.get("d1")?.amendRounds).toBe(0);
    expect(rec.amend).toHaveLength(0);
  });

  it("amends once when the review is blocking then clean, recording the round + cost", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["blocking", "clean"] });

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    const d = repo.get("d1");
    expect(d?.state).toBe("done");
    expect(d?.amendRounds).toBe(1);
    expect(rec.amend).toHaveLength(1);
    expect(rec.amend[0]?.findings).toBe("the findings");
    expect(rec.review).toHaveLength(2); // initial + the re-review after the amend
    expect(d?.amendCostUsd).toBeGreaterThan(0);
    expect(d?.reviewCostUsd).toBeGreaterThan(0);
  });

  it("escalates (re-decompose) when the review stays blocking past the cap", async () => {
    enqueue("d1");
    const cap2 = { ...CONFIG, amendCap: 2 };
    // blocking through the cap: review → amend → review → amend → review(blocking, cap hit)
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["blocking", "blocking", "blocking"] });

    await new DispatchDaemon(repo, cap2, legs, fakeReconcile).runOnce();

    const d = repo.get("d1");
    expect(d?.state).toBe("escalated");
    expect(d?.escalated).toBe("re-decompose");
    expect(d?.amendRounds).toBe(2);
    expect(rec.amend).toHaveLength(2);
    expect(rec.review).toHaveLength(3);
  });

  it("escalates immediately when an amend changes nothing (the builder is stuck)", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["blocking"], amendChanges: false });

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    const d = repo.get("d1");
    expect(d?.state).toBe("escalated");
    expect(d?.escalated).toBe("re-decompose");
    expect(d?.amendRounds).toBe(1);
    expect(rec.amend).toHaveLength(1);
    expect(rec.review).toHaveLength(1); // no wasted re-review of identical code
  });

  it("resumes an interrupted amend by re-reviewing", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    repo.setPr("d1", "https://github.com/acme/widgets/pull/7");
    repo.transition("d1", "review");
    repo.transition("d1", "amending"); // an amend was in flight when the daemon died
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["clean"] });

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.build).toHaveLength(0);
    expect(rec.review).toHaveLength(1);
  });
});

// ADR 0020 slice 4b: the owner reviews the session PR; reopenForReview parks the owner's
// findings on the (done) dispatch and moves it to amending. The daemon amends against them
// (NOT against a fresh review), then the normal review cycle re-reviews + re-merges.
describe("owner-review reopen", () => {
  // A dispatch that built, reviewed clean, and merged into session-main — at rest in `done`.
  function seedDone(id: string): void {
    repo.create({
      id,
      issueId: ISSUE.id,
      title: ISSUE.title,
      branch: dispatchBranch(ISSUE),
      spec: ISSUE.body,
      sessionBranch: "session-main-S1",
    });
    repo.transition(id, "building");
    repo.transition(id, "review");
    repo.transition(id, "done");
  }

  it("does not drive a done dispatch at rest (no pending findings) — the daemon sleeps", async () => {
    seedDone("d1");
    const { legs, rec } = fakeLegs();

    const driven = await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(driven).toBe(0); // parked like escalated — skipped, not counted
    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.amend).toHaveLength(0);
  });

  it("amends against the owner's findings, then re-reviews + re-merges into session-main", async () => {
    seedDone("d1");
    repo.reopenForReview("d1", "the owner's note: rename foo to bar");
    expect(repo.get("d1")?.state).toBe("amending");
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["clean"] });

    const driven = await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    expect(driven).toBe(1);
    const d = repo.get("d1");
    expect(d?.state).toBe("done"); // back to rest after the fix re-merged
    expect(d?.pendingFindings).toBeNull(); // consumed
    expect(d?.amendRounds).toBe(1);
    expect(rec.amend).toHaveLength(1);
    expect(rec.amend[0]?.findings).toBe("the owner's note: rename foo to bar"); // owner notes, not a review
    expect(rec.build).toHaveLength(0); // reopen amends, never rebuilds
    expect(rec.review).toHaveLength(1); // re-review of the fix
    expect(rec.merge).toHaveLength(1); // fix re-merged into session-main
  });

  it("escalates 'attended' when the builder can't action the owner's note", async () => {
    seedDone("d1");
    repo.reopenForReview("d1", "please rethink the whole approach");
    const { legs, rec } = fakeLegs({ amendChanges: false });

    await new DispatchDaemon(repo, CONFIG, legs, fakeReconcile).runOnce();

    const d = repo.get("d1");
    expect(d?.state).toBe("escalated");
    expect(d?.escalated).toBe("attended"); // owner asked; cheap builder couldn't — needs the chief/owner
    expect(d?.pendingFindings).toBeNull();
    expect(rec.review).toHaveLength(0); // nothing changed — no wasted re-review
    expect(rec.merge).toHaveLength(0);
  });
});
