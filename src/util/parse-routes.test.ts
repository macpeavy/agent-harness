import { describe, expect, it } from "bun:test";
import { parseRoutes } from "./parse-routes";

describe("parseRoutes", () => {
  it("splits a normal CSV", () => {
    expect(parseRoutes("a, b, c")).toEqual(["a", "b", "c"]);
  });

  it("strips surrounding whitespace", () => {
    expect(parseRoutes("  foo , bar  ,  baz ")).toEqual(["foo", "bar", "baz"]);
  });

  it("falls back to the default spike routes when input is undefined", () => {
    const routes = parseRoutes();
    expect(routes).toEqual(["builder", "builder-alt", "reviewer"]);
  });

  it("throws on empty input", () => {
    expect(() => parseRoutes("")).toThrow("parseRoutes: no routes parsed");
  });

  it("throws on whitespace-only input", () => {
    expect(() => parseRoutes("  , , ")).toThrow("parseRoutes: no routes parsed");
  });
});