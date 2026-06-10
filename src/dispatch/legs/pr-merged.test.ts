import { describe, expect, it } from "bun:test";
import { failedChecksFrom } from "./pr-merged";

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
