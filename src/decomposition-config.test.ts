import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DECOMPOSITION, loadDecompositionConfig } from "./decomposition-config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-decomp-cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadDecompositionConfig (ADR 0022)", () => {
  it("loads + validates the two dials from YAML", () => {
    const path = join(dir, "decomposition.yaml");
    writeFileSync(path, "chunkTargetLines: 180\nsessionTargetLines: 1200\n");
    expect(loadDecompositionConfig(path)).toEqual({ chunkTargetLines: 180, sessionTargetLines: 1200 });
  });

  it("falls back to the seed defaults when the file is absent (soft guidance, never bricks)", () => {
    expect(loadDecompositionConfig(join(dir, "missing.yaml"))).toEqual(DEFAULT_DECOMPOSITION);
  });

  it("throws on a malformed file rather than silently using a different number", () => {
    const path = join(dir, "bad.yaml");
    writeFileSync(path, "chunkTargetLines: not-a-number\nsessionTargetLines: 1000\n");
    expect(() => loadDecompositionConfig(path)).toThrow(/invalid/);
  });

  it("rejects a missing dial (both are required)", () => {
    const path = join(dir, "partial.yaml");
    writeFileSync(path, "chunkTargetLines: 250\n");
    expect(() => loadDecompositionConfig(path)).toThrow(/invalid/);
  });

  it("the shipped config/decomposition.yaml is valid and carries both dials", () => {
    const cfg = loadDecompositionConfig("config/decomposition.yaml");
    expect(cfg.chunkTargetLines).toBeGreaterThan(0);
    expect(cfg.sessionTargetLines).toBeGreaterThan(0);
  });
});
