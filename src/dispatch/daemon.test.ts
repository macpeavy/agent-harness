import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchDaemon, type DispatchLegs } from "./daemon";
import { dispatchBranch, type BuildResult, type Issue } from "./legs/build";
import type { ReviewResult, ReviewTarget } from "./legs/review";
import type { SubstrateConfig } from "../config";
import { DispatchRepository } from "../substrate/dispatch";

const CONFIG: SubstrateConfig = {
  repoPath: "/repo",
  ghRepo: "acme/widgets",
  worktreeRoot: "/tmp/ah-test-wt",
  builderAgent: "builder",
  reviewerAgent: "reviewer",
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
}

// Fake legs that record their calls and return canned success results. `buildOver`
// lets a test tweak the build result (e.g. changed:false) or throw by issue id.
function fakeLegs(opts: { buildThrowsFor?: string; changed?: boolean } = {}): {
  legs: DispatchLegs;
  rec: Recorder;
} {
  const rec: Recorder = { build: [], review: [] };
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
        prUrl: changed ? "https://github.com/acme/widgets/pull/7" : undefined,
        route: "builder",
        buildSessionId: "ses_build",
        tokens: { input: 1000, output: 500 },
      };
      return result;
    },
    async review(target) {
      rec.review.push(target);
      const result: ReviewResult = {
        pr: target.pr,
        branch: target.branch,
        review: "LGTM",
        waitedMs: 10,
        route: "reviewer",
        reviewSessionId: "ses_review",
        tokens: { input: 2000, output: 800 },
      };
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
    expect(d?.prUrl).toContain("/pull/7");
    expect(d?.buildSessionId).toBe("ses_build");
    expect(d?.reviewSessionId).toBe("ses_review");
    expect(d?.route).toBe("builder");
    expect(d?.buildCostUsd).toBeGreaterThan(0);
    expect(d?.reviewCostUsd).toBeGreaterThan(0);

    expect(rec.build).toHaveLength(1);
    expect(rec.review).toHaveLength(1);
    expect(rec.review[0]?.pr).toBe(7);
  });

  it("builds from the dispatch's stored spec", async () => {
    enqueue("d1", { id: "ISSUE-9", title: "Custom", body: "the exact spec" });
    const { legs, rec } = fakeLegs();
    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(rec.build[0]?.body).toBe("the exact spec");
    expect(rec.build[0]?.id).toBe("ISSUE-9");
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

  it("resumes a review dispatch by re-running only the review, on the stored branch/PR", async () => {
    enqueue("d1");
    repo.transition("d1", "building");
    repo.setPr("d1", "https://github.com/acme/widgets/pull/9");
    repo.transition("d1", "review");
    const { legs, rec } = fakeLegs();

    await new DispatchDaemon(repo, CONFIG, legs).runOnce();

    expect(repo.get("d1")?.state).toBe("done");
    expect(rec.build).toHaveLength(0);
    expect(rec.review).toHaveLength(1);
    expect(rec.review[0]?.pr).toBe(9);
    expect(rec.review[0]?.branch).toBe(dispatchBranch(ISSUE));
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
