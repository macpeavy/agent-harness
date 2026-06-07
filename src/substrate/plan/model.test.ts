import { describe, expect, it } from "bun:test";
import { validateDag } from "./model";

describe("validateDag", () => {
  it("accepts a sound DAG (returns null)", () => {
    expect(validateDag(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }])).toBeNull();
  });

  it("accepts chunks with no edges", () => {
    expect(validateDag(["a", "b"], [])).toBeNull();
  });

  it("rejects a duplicate chunk id", () => {
    expect(validateDag(["a", "a"], [])).toContain("duplicate chunk id a");
  });

  it("rejects a self-edge", () => {
    expect(validateDag(["a"], [{ from: "a", to: "a" }])).toContain("self-edge");
  });

  it("rejects an edge referencing an unknown chunk", () => {
    expect(validateDag(["a"], [{ from: "a", to: "ghost" }])).toContain("unknown chunk ghost");
  });

  it("rejects a duplicate edge", () => {
    expect(validateDag(["a", "b"], [{ from: "a", to: "b" }, { from: "a", to: "b" }])).toContain("duplicate edge");
  });

  it("rejects a direct cycle", () => {
    expect(validateDag(["a", "b"], [{ from: "a", to: "b" }, { from: "b", to: "a" }])).toContain("cycle");
  });

  it("rejects a longer cycle", () => {
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }];
    expect(validateDag(["a", "b", "c"], edges)).toContain("cycle");
  });

  it("accepts a diamond (shared dependency, not a cycle)", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    expect(validateDag(["a", "b", "c", "d"], edges)).toBeNull();
  });
});
