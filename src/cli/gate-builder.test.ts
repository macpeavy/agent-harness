import { describe, expect, it } from "bun:test";
import { evaluateGate, type GateSignals } from "./gate-builder";

// A model that writes the file cleanly under budget.
const GOOD: GateSignals = {
  changed: true,
  fileExists: true,
  typechecks: true,
  wroteViaTool: true,
  costUsd: 0.002,
  timedOut: false,
};

describe("evaluateGate (ADR 0025 builder-acceptance assertions)", () => {
  it("passes a clean build (writes a typechecking file, via a tool, under budget)", () => {
    expect(evaluateGate(GOOD)).toEqual({ pass: true, failures: [] });
  });

  it("FAILS assertion 1 on a no-op (the Mistral failure: changed:false)", () => {
    const v = evaluateGate({ ...GOOD, changed: false, fileExists: false, typechecks: false, wroteViaTool: false });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.startsWith("1 "))).toBe(true);
  });

  it("FAILS assertion 4 on a hang / empty-loop (the Mistral 50-turn spin)", () => {
    const v = evaluateGate({ ...GOOD, changed: false, timedOut: true });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.startsWith("4 (budget)"))).toBe(true);
  });

  it("FAILS assertion 3 on text-emitted tool calls (the qwen failure)", () => {
    const v = evaluateGate({ ...GOOD, wroteViaTool: false });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.startsWith("3 "))).toBe(true);
  });

  it("FAILS assertion 2 when the file is written but doesn't typecheck", () => {
    const v = evaluateGate({ ...GOOD, typechecks: false });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.startsWith("2 (typecheck)"))).toBe(true);
  });

  it("FAILS assertion 4 when cost exceeds the ceiling", () => {
    const v = evaluateGate({ ...GOOD, costUsd: 0.5 });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.startsWith("4 (cost)"))).toBe(true);
  });

  it("does NOT fail assertion 3 when the session couldn't be inspected (null defers to #1)", () => {
    // changed:true already implies a real write tool call (text can't edit a file), so an
    // un-inspectable session is not a failure.
    expect(evaluateGate({ ...GOOD, wroteViaTool: null }).pass).toBe(true);
  });
});
