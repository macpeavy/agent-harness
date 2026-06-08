import { describe, expect, it } from "bun:test";
import { chunkGuidance, sessionGuidance } from "./decompose-context";

const CFG = { chunkTargetLines: 250, sessionTargetLines: 1000 };

describe("decompose-context guidance (ADR 0022)", () => {
  it("renders the chunk dial as a soft target, by name, with the invariant kept separate", () => {
    const g = chunkGuidance(CFG);
    expect(g).toContain("250");
    expect(g).toContain("chunkTargetLines");
    expect(g).toMatch(/soft|lean|judgment/i); // framed as a lean, not a cap
    expect(g).toContain("no two parallel chunks touch the same file"); // the invariant, not a number
    expect(g).toContain("rides"); // one-liner rides with its consumer
  });

  it("renders the session dial as a soft target, by name", () => {
    const g = sessionGuidance(CFG);
    expect(g).toContain("1000");
    expect(g).toContain("sessionTargetLines");
    expect(g).toMatch(/soft|lean/i);
  });

  it("tracks the configured numbers, not a hardcoded one", () => {
    expect(chunkGuidance({ chunkTargetLines: 99, sessionTargetLines: 500 })).toContain("99");
    expect(sessionGuidance({ chunkTargetLines: 99, sessionTargetLines: 500 })).toContain("500");
  });
});
