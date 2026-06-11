import { describe, expect, it } from "bun:test";
import { fingerprintTokens, flagDroppings } from "./droppings";

// The PR #151 shape: chunk feat-144-claudemd-s1-c1 on session-main-feat-144-claudemd-s1
// shipped docs/tests/claudemd-144.md — named after the work item, referenced by nothing.
const TOKENS = fingerprintTokens(
  "agent/feat-144-claudemd-s1-c1-rewrite-claude-md",
  "session-main-feat-144-claudemd-s1",
  "feat-144-claudemd-s1-c1",
);

const allReferenced = () => true;
const noneReferenced = () => false;

describe("fingerprintTokens", () => {
  it("strips the structural branch prefixes and drops empties", () => {
    expect(fingerprintTokens("session-main-feat-x", "agent/feat-x-c1", null, undefined)).toEqual([
      "feat-x",
      "feat-x-c1",
    ]);
  });
});

describe("flagDroppings — the fingerprint rule", () => {
  it("flags the PR #151 dropping: a file echoing the work item's distinctive words", () => {
    const flags = flagDroppings(["docs/tests/claudemd-144.md"], TOKENS, allReferenced);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.path).toBe("docs/tests/claudemd-144.md");
    expect(flags[0]?.reason).toContain("named after the work item");
  });

  it("flags a file containing the whole work-item id", () => {
    const flags = flagDroppings(["notes/feat-144-claudemd-s1-c1.txt"], TOKENS, allReferenced);
    expect(flags[0]?.reason).toContain("named after the work item");
  });

  it("does not flag a referenced file sharing only ONE distinctive word", () => {
    // "claudemd" alone (e.g. a legitimate module in the same area) is not a fingerprint.
    expect(flagDroppings(["src/claudemd-render.ts"], TOKENS, allReferenced)).toEqual([]);
  });
});

describe("flagDroppings — the reference rule", () => {
  it("flags an unreferenced new file with no fingerprint", () => {
    const flags = flagDroppings(["docs/random-notes.md"], TOKENS, noneReferenced);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toContain("no inbound reference");
  });

  it("passes a referenced new file", () => {
    expect(flagDroppings(["src/cli/new-module.ts"], TOKENS, allReferenced)).toEqual([]);
  });
});

describe("flagDroppings — exemptions", () => {
  it("exempts co-located test files (wired by the runner, named after their subject)", () => {
    expect(flagDroppings(["src/claudemd-render.test.ts"], TOKENS, noneReferenced)).toEqual([]);
  });

  it("exempts generated drizzle migrations (wired by the journal)", () => {
    expect(flagDroppings(["drizzle/0015_anything.sql"], TOKENS, noneReferenced)).toEqual([]);
  });

  it("returns [] for no added files", () => {
    expect(flagDroppings([], TOKENS, noneReferenced)).toEqual([]);
  });
});
