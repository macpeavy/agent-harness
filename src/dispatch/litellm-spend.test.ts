import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPath, parseSpendLedger, readSpendLedger, spendInWindow, type SpendRecord } from "./litellm-spend";

function line(r: Partial<SpendRecord>): string {
  return JSON.stringify({
    tsStart: 1000,
    tsEnd: 2000,
    route: "builder",
    model: "openrouter/anthropic/claude-haiku-4.5",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.01,
    callId: "c1",
    ...r,
  });
}

describe("parseSpendLedger", () => {
  it("parses one record per non-blank line", () => {
    const text = [line({ route: "chief", costUsd: 0.02 }), "", line({ route: "reviewer", costUsd: 0.03 })].join("\n");
    const records = parseSpendLedger(text);
    expect(records).toHaveLength(2);
    expect(records[0]!.route).toBe("chief");
    expect(records[0]!.costUsd).toBe(0.02);
    expect(records[1]!.route).toBe("reviewer");
  });

  it("skips a malformed (half-written) final line rather than throwing", () => {
    const text = line({}) + '\n{"tsStart":1000,"costUsd":'; // truncated trailing line
    const records = parseSpendLedger(text);
    expect(records).toHaveLength(1);
  });

  it("skips a line with no cost (no spend signal)", () => {
    const text = JSON.stringify({ route: "chief", tsStart: 1, tsEnd: 2 }); // costUsd missing
    expect(parseSpendLedger(text)).toHaveLength(0);
  });

  it("defaults missing token counts to 0 and tolerates null timestamps", () => {
    const text = JSON.stringify({ route: "builder", costUsd: 0.5, tsStart: null, tsEnd: null });
    const [r] = parseSpendLedger(text);
    expect(r!.promptTokens).toBe(0);
    expect(r!.totalTokens).toBe(0);
    expect(r!.tsStart).toBeNull();
  });
});

describe("spendInWindow", () => {
  const records: SpendRecord[] = parseSpendLedger(
    [
      line({ route: "builder", tsStart: 100, tsEnd: 200, costUsd: 0.01 }), // in window, right route
      line({ route: "builder", tsStart: 150, tsEnd: 180, costUsd: 0.02 }), // in window, right route
      line({ route: "reviewer", tsStart: 120, tsEnd: 160, costUsd: 0.99 }), // wrong route
      line({ route: "builder", tsStart: 50, tsEnd: 90, costUsd: 0.5 }), // before window
      line({ route: "builder", tsStart: 250, tsEnd: 400, costUsd: 0.5 }), // after window
      line({ route: "builder", tsStart: 180, tsEnd: 260, costUsd: 0.5 }), // straddles end — excluded
    ].join("\n"),
  );

  it("sums only the matching route's calls fully inside the window", () => {
    expect(spendInWindow(records, "builder", 100, 240)).toBeCloseTo(0.03, 6);
  });

  it("isolates a different route", () => {
    expect(spendInWindow(records, "reviewer", 100, 240)).toBeCloseTo(0.99, 6);
  });

  it("returns 0 when nothing matches", () => {
    expect(spendInWindow(records, "chief", 100, 240)).toBe(0);
    expect(spendInWindow([], "builder", 0, 1e12)).toBe(0);
  });

  it("excludes records with null timestamps (unplaceable)", () => {
    const withNull = parseSpendLedger(line({ route: "builder", tsStart: null, tsEnd: null, costUsd: 9 }));
    expect(spendInWindow(withNull, "builder", 0, 1e12)).toBe(0);
  });
});

describe("ledgerPath + readSpendLedger", () => {
  let dir: string;
  const savedEnv = process.env.AH_SPEND_LEDGER;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ah-spend-"));
    delete process.env.AH_SPEND_LEDGER;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AH_SPEND_LEDGER;
    else process.env.AH_SPEND_LEDGER = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to <repoPath>/.substrate/litellm-spend.jsonl and honours AH_SPEND_LEDGER", () => {
    expect(ledgerPath("/repo")).toBe("/repo/.substrate/litellm-spend.jsonl");
    process.env.AH_SPEND_LEDGER = "/custom/ledger.jsonl";
    expect(ledgerPath("/repo")).toBe("/custom/ledger.jsonl");
  });

  it("returns [] when the ledger file is absent", () => {
    expect(readSpendLedger(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("reads and parses an existing ledger", () => {
    const path = join(dir, "spend.jsonl");
    writeFileSync(path, [line({ route: "chief", costUsd: 0.07 }), line({ route: "builder", costUsd: 0.01 })].join("\n"));
    const records = readSpendLedger(path);
    expect(records).toHaveLength(2);
    expect(spendInWindow(records, "chief", 0, 1e12)).toBeCloseTo(0.07, 6);
  });
});
