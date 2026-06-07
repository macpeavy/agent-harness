import { describe, expect, it } from "bun:test";
import { formatDuration, formatUsd } from "./format";

describe("formatUsd", () => {
  it("formats a small USD value with 4 decimal places", () => {
    expect(formatUsd(0.0023)).toBe("$0.0023");
  });

  it("formats zero correctly", () => {
    expect(formatUsd(0)).toBe("$0.0000");
  });

  it("rounds half-up using toFixed behavior", () => {
    // toFixed rounds half-up, so 0.00125 becomes 0.0013
    expect(formatUsd(0.00125)).toBe("$0.0013");
  });

  it("converts NaN to $0.0000", () => {
    expect(formatUsd(NaN)).toBe("$0.0000");
  });

  it("converts Infinity to $0.0000", () => {
    expect(formatUsd(Infinity)).toBe("$0.0000");
  });

  it("converts negative Infinity to $0.0000", () => {
    expect(formatUsd(-Infinity)).toBe("$0.0000");
  });

  it("converts negative amounts to $0.0000", () => {
    expect(formatUsd(-100)).toBe("$0.0000");
    expect(formatUsd(-0.001)).toBe("$0.0000");
    expect(formatUsd(-1)).toBe("$0.0000");
  });

  it("handles large amounts correctly", () => {
    expect(formatUsd(1234567.89)).toBe("$1234567.8900");
  });
});

describe("formatDuration", () => {
  it("formats milliseconds under 1 second correctly", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds with one decimal place (1s to 60s)", () => {
    expect(formatDuration(2_300)).toBe("2.3s");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("formats minutes and seconds correctly (1m to 60m)", () => {
    expect(formatDuration(83_000)).toBe("1m 23s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("formats hours and minutes correctly (>= 1 hour)", () => {
    expect(formatDuration(3_725_000)).toBe("1h 2m");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(100_000_000)).toBe("27h 46m");
  });

  it("formats zero as 0ms", () => {
    expect(formatDuration(0)).toBe("0ms");
  });

  it("handles non-finite inputs by returning 0ms", () => {
    expect(formatDuration(NaN)).toBe("0ms");
    expect(formatDuration(Infinity)).toBe("0ms");
    expect(formatDuration(-Infinity)).toBe("0ms");
  });

  it("guards negative inputs by returning 0ms", () => {
    expect(formatDuration(-1)).toBe("0ms");
    expect(formatDuration(-1000)).toBe("0ms");
    expect(formatDuration(-999_999)).toBe("0ms");
  });

  it("handles edge case of exactly 1000ms", () => {
    expect(formatDuration(1000)).toBe("1.0s");
  });

  it("handles very large numbers correctly", () => {
    expect(formatDuration(1_000_000_000)).toBe("277h 46m");
    expect(formatDuration(Number.MAX_SAFE_INTEGER)).toBe("2501999792h 59m");
  });
});
