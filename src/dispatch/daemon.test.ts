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

const CONFIG: SubstrateConfig = {
  repoPath: "/repo",
  ghRepo: "acme/widgets",
  worktreeRoot: "/tmp/ah-test-wt",
  builderAgent: "builder",
  builderStrongAgent: "builder-strong",
  reviewerAgent: "reviewer",
  amendCap: 3,
};

const ISSUE: Issue = { id: "ISSUE-1", title: "Add a thing", body: "Do the thing." };

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
    const daemon = new DispatchDaemon(repo, CONFIG, legs);

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
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

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
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(rec.build[0]?.surface).toBe("src/substrate/dispatch/schema.ts");
    expect(rec.build[0]?.skills).toEqual(["persistence-drizzle", "writing-tests"]); // JSON round-trip
  });

  it("leaves surface/skills undefined when the row carries none (standards-only fallback)", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs();
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

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
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(rec.build[0]?.tier).toBe("strong"); // the build leg resolves this → builderStrongAgent
  });
});

describe("build that changes nothing", () => {
  it("fails the dispatch and never reaches review", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs({ changed: false });
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(repo.get("d1")?.state).toBe("failed");
    expect(rec.review).toHaveLength(0);
  });
});

describe("crash recovery", () => {
  it("resumes a building dispatch by re-running the build", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    const { legs, rec } = fakeLegs();

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.build).toHaveLength(1);
  });

  it("resumes a review dispatch by re-running only the review, on the stored branch", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    repo.transition("d1", "review");
    const { legs, rec } = fakeLegs();

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

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
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.merge).toHaveLength(1);
    expect(rec.merge[0]).toMatchObject({ branch: dispatchBranch(ISSUE), sessionBranch: "session-main-S1" });
  });

  it("does not merge when the dispatch has no session-main branch (legacy build-off-main)", async () => {
    enqueue("d1"); // no sessionBranch
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["clean"] });
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

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
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(rec.merge).toHaveLength(1); // once, after the clean re-review — not on the blocking pass
  });
});

describe("parked dispatches", () => {
  it("does not run an escalated dispatch — it waits to be rewoken", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    repo.escalate("d1", "attended");
    const { legs, rec } = fakeLegs();

    const driven = await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(driven).toBe(0);
    expect(repo.get("d1")?.state).toBe("escalated");
    expect(rec.build).toHaveLength(0);
    expect(rec.review).toHaveLength(0);
  });
});

describe("fault isolation", () => {
  it("fails the dispatch whose build throws and still drives the others", async () => {
    enqueue("bad", { id: "BAD", title: "Breaks", body: "boom" });
    enqueue("good", { id: "GOOD", title: "Works", body: "fine" });
    const { legs } = fakeLegs({ buildThrowsFor: "BAD" });

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(repo.get("bad")?.state).toBe("failed");
    expect(repo.get("good")?.state).toBe("done");
  });
});

describe("the amend cycle", () => {
  it("a clean review goes straight to done — no amend round", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["clean"] });

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(repo.get("d1")?.amendRounds).toBe(0);
    expect(rec.amend).toHaveLength(0);
  });

  it("amends once when the review is blocking then clean, recording the round + cost", async () => {
    enqueue("d1");
    const { legs, rec } = fakeLegs({ reviewVerdicts: ["blocking", "clean"] });

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

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

    await new DispatchDaemon(repo, cap2, legs).runOnce();

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

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

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

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.build).toHaveLength(0);
    expect(rec.review).toHaveLength(1);
  });
});
