import { describe, expect, it } from "bun:test";
import { parseVerdict } from "./review";

describe("parseVerdict", () => {
  it("reads a blocking verdict", () => {
    expect(parseVerdict("Finding 1: ...\n\nVERDICT: blocking")).toBe("blocking");
  });

  it("reads a clean verdict", () => {
    expect(parseVerdict("Looks good.\nVERDICT: clean")).toBe("clean");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseVerdict("  verdict:   CLEAN  ")).toBe("clean");
  });

  it("takes the last verdict line when more than one appears", () => {
    expect(parseVerdict("VERDICT: clean\n...revised...\nVERDICT: blocking")).toBe("blocking");
  });

  it("defaults to blocking when no verdict line is present", () => {
    // Safe default — never auto-ship a review we couldn't classify.
    expect(parseVerdict("Some findings with no verdict line.")).toBe("blocking");
  });

  it("ignores the word verdict mid-sentence — only a leading VERDICT: line counts", () => {
    expect(parseVerdict("My verdict is that it's fine, honestly.")).toBe("blocking");
  });
});
