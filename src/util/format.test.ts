import { describe, expect, it } from "bun:test";
import { formatDuration, formatUsd } from "./format";

describe("formatUsd", () => {
  it("formats a normal value with 4 decimals", () => {
    expect(formatUsd(0.0023)).toBe("$0.0023");
  });

  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0.0000");
  });

  it("rounds values according to toFixed(4)", () => {
    expect(formatUsd(0.00125)).toBe("$0.0013");
    expect(formatUsd(0.00124)).toBe("$0.0012");
  });

  it("handles negative values as given", () => {
    expect(formatUsd(-0.0023)).toBe("$-0.0023");
  });

  it("guards non-finite and returns $0.0000", () => {
    expect(formatUsd(NaN)).toBe("$0.0000");
    expect(formatUsd(Infinity)).toBe("$0.0000");
    expect(formatUsd(-Infinity)).toBe("$0.0000");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds (< 1000ms)", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(0)).toBe("0ms");
  });

  it("formats seconds with one decimal (< 60_000ms)", () => {
    expect(formatDuration(2_300)).toBe("2.3s");
  });

  it("formats minutes + seconds (< 3_600_000ms)", () => {
    expect(formatDuration(83_000)).toBe("1m 23s");
  });

  it("formats hours + minutes (>= 3_600_000ms)", () => {
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });

  it("handles negative input by returning 0ms", () => {
    expect(formatDuration(-100)).toBe("0ms");
    expect(formatDuration(-10000)).toBe("0ms");
  });

  it("guards non-finite and returns 0ms", () => {
    expect(formatDuration(NaN)).toBe("0ms");
    expect(formatDuration(Infinity)).toBe("0ms");
    expect(formatDuration(-Infinity)).toBe("0ms");
  });
});
