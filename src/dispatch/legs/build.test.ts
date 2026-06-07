import { describe, expect, it } from "bun:test";
import { buildPrompt, dispatchBranch, type Issue } from "./build";

const ISSUE: Issue = { id: "AGENT-1", title: "Add a thing", body: "do the thing" };

describe("dispatchBranch", () => {
  it("is deterministic and slugged from the issue", () => {
    expect(dispatchBranch(ISSUE)).toBe("agent/agent-1-add-a-thing");
  });
});

describe("buildPrompt", () => {
  it("pushes the context pack ahead of the issue", () => {
    const prompt = buildPrompt(ISSUE, "PACK CONTENT");
    expect(prompt.indexOf("PACK CONTENT")).toBeLessThan(prompt.indexOf("Issue AGENT-1"));
    expect(prompt).toContain("do the thing");
  });

  it("omits the separator when the pack is empty", () => {
    const prompt = buildPrompt(ISSUE, "");
    expect(prompt).not.toContain("---");
    expect(prompt.startsWith("Implement the following issue")).toBe(true);
  });
});
