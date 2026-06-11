import { describe, expect, it } from "bun:test";
import { failedChecksFrom, latestOwnerResponseFrom } from "./pr-merged";

describe("failedChecksFrom", () => {
  it("returns [] for no rollup (no CI configured) or an empty one", () => {
    expect(failedChecksFrom(null)).toEqual([]);
    expect(failedChecksFrom(undefined)).toEqual([]);
    expect(failedChecksFrom([])).toEqual([]);
  });

  it("collects CheckRuns that concluded FAILURE or TIMED_OUT, by name", () => {
    expect(
      failedChecksFrom([
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "slow-suite", status: "COMPLETED", conclusion: "TIMED_OUT" },
        { __typename: "CheckRun", name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" },
      ]),
    ).toEqual(["test", "slow-suite"]);
  });

  it("a pending check is not a failure yet", () => {
    expect(failedChecksFrom([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS" }])).toEqual([]);
  });

  it("a CANCELLED check is not a failure (usually a superseding push, not a verdict)", () => {
    expect(
      failedChecksFrom([{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "CANCELLED" }]),
    ).toEqual([]);
  });

  it("collects StatusContexts in FAILURE or ERROR, by context", () => {
    expect(
      failedChecksFrom([
        { __typename: "StatusContext", context: "ci/build", state: "FAILURE" },
        { __typename: "StatusContext", context: "ci/deploy-preview", state: "ERROR" },
        { __typename: "StatusContext", context: "ci/lint", state: "SUCCESS" },
      ]),
    ).toEqual(["ci/build", "ci/deploy-preview"]);
  });

  it("an unnamed item still surfaces rather than vanishing", () => {
    expect(failedChecksFrom([{ conclusion: "FAILURE" }])).toEqual(["unnamed check"]);
  });
});

describe("latestOwnerResponseFrom (the owner-response taxonomy, AGENT-54)", () => {
  const T1 = "2026-06-11T10:00:00Z";
  const T2 = "2026-06-11T11:00:00Z";

  it("returns null when there is nothing (no reviews, no comments)", () => {
    expect(latestOwnerResponseFrom(null, null, "bot")).toBeNull();
    expect(latestOwnerResponseFrom([], [], "bot")).toBeNull();
  });

  it("counts a CHANGES_REQUESTED review even with no body — the verdict is the feedback", () => {
    const at = latestOwnerResponseFrom(
      [{ author: { login: "owner" }, state: "CHANGES_REQUESTED", body: "", submittedAt: T1 }],
      [],
      "bot",
    );
    expect(at).toBe(Date.parse(T1));
  });

  it("counts a COMMENTED review only when it carries a note", () => {
    expect(
      latestOwnerResponseFrom([{ author: { login: "owner" }, state: "COMMENTED", body: "  ", submittedAt: T1 }], [], "bot"),
    ).toBeNull();
    expect(
      latestOwnerResponseFrom([{ author: { login: "owner" }, state: "COMMENTED", body: "a note", submittedAt: T1 }], [], "bot"),
    ).toBe(Date.parse(T1));
  });

  it("never counts an APPROVED review — that's the merge path, not amend feedback", () => {
    expect(
      latestOwnerResponseFrom([{ author: { login: "owner" }, state: "APPROVED", body: "lgtm!", submittedAt: T1 }], [], "bot"),
    ).toBeNull();
  });

  it("counts a Conversation-tab issue comment with a body", () => {
    expect(latestOwnerResponseFrom([], [{ author: { login: "owner" }, body: "please also fix X", createdAt: T1 }], "bot")).toBe(
      Date.parse(T1),
    );
  });

  it("filters the bot's own identity out of both sources", () => {
    expect(
      latestOwnerResponseFrom(
        [{ author: { login: "bot" }, state: "CHANGES_REQUESTED", body: "self", submittedAt: T1 }],
        [{ author: { login: "bot" }, body: "annotation", createdAt: T2 }],
        "bot",
      ),
    ).toBeNull();
  });

  it("with an unknown bot login (null), filters nothing — over-reads rather than misses", () => {
    expect(latestOwnerResponseFrom([], [{ author: { login: "bot" }, body: "x", createdAt: T1 }], null)).toBe(Date.parse(T1));
  });

  it("returns the LATEST activity across both sources — the wave key", () => {
    const at = latestOwnerResponseFrom(
      [{ author: { login: "owner" }, state: "CHANGES_REQUESTED", body: "fix it", submittedAt: T1 }],
      [{ author: { login: "owner" }, body: "and one more thing", createdAt: T2 }],
      "bot",
    );
    expect(at).toBe(Date.parse(T2));
  });

  it("ignores entries with a missing/unparseable timestamp", () => {
    expect(latestOwnerResponseFrom([{ author: { login: "owner" }, state: "CHANGES_REQUESTED", body: "x" }], [], "bot")).toBeNull();
  });
});
