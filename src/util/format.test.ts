import { describe, expect, it } from "bun:test";
import { formatDuration, formatUsd } from "./format";

describe("formatUsd", () => {
  it("formats a normal USD value with 4 decimals", () => {
    expect(formatUsd(0.0023)).toBe("$0.0023");
  });

  it("formats zero as $0.0000", () => {
    expect(formatUsd(0)).toBe("$0.0000");
  });

  it("rounds using toFixed behavior", () => {
    // toFixed rounds half-up, so 0.00125 becomes 0.0013
    expect(formatUsd(0.00125)).toBe("$0.0013");
  });

  it("guards non-finite inputs", () => {
    expect(formatUsd(NaN)).toBe("$0.0000");
    expect(formatUsd(Infinity)).toBe("$0.0000");
    expect(formatUsd(-Infinity)).toBe("$0.0000");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds (< 1000)", () => {
    expect(formatDuration(450)).toBe("450ms");
  });

  it("formats seconds with one decimal (< 60000)", () => {
    expect(formatDuration(2_300)).toBe("2.3s");
  });

  it("formats minutes and seconds (< 3600000)", () => {
    expect(formatDuration(83_000)).toBe("1m 23s");
  });

  it("formats hours and minutes (>= 3600000)", () => {
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });

  it("formats zero as 0ms", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  it("guards non-finite inputs", () => {
    expect(formatDuration(NaN)).toBe("0ms");
    expect(formatDuration(Infinity)).toBe("0ms");
  });

  it("guards negative inputs", () => {
    expect(formatDuration(-1)).toBe("0ms");
    expect(formatDuration(-1000)).toBe("0ms");
  });
});
