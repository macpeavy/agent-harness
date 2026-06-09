// The LiteLLM spend ledger reader (ADR 0026, AGENT-41) — the substrate side of the cost
// system of record. The gateway callback (config/litellm_spend_logger.py) appends one JSONL
// line per call with LiteLLM's own computed cost, tagged by route (model_group) and bounded by
// wall-clock timestamps. This module parses that ledger and reconciles REAL per-route spend over
// a time window — the source that replaces token-count estimation (cost.ts) for recorded cost.
//
// Attribution is by (route, time-window): a leg's recorded cost is the sum of ledger lines on
// its route whose call window falls inside the leg's [start, end]. The chief — which is an
// interactive session, not a dispatch — is attributed by its own route over a feature's window.
//
// Caveat (the honest limit): two dispatches on the SAME route running concurrently share a
// window and can't be split by the ledger alone (the gateway sees the route, not which dispatch
// a call belongs to). At the spike's attended scale — usually one feature, sequential legs —
// this is exact; concurrent same-route builds would over-attribute. The precise fix is a
// per-dispatch gateway key (a later lever, ADR 0026 open question), not this slice.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One billed call, as the gateway callback records it. Timestamps are wall-clock epoch ms on
 *  the same host as the daemon's clock, so leg windows and ledger windows line up. */
export interface SpendRecord {
  tsStart: number | null;
  tsEnd: number | null;
  /** The route the call was billed under — the model_list name (chief / reviewer / builder /
   *  builder-strong / builder-nano / builder-gemini). The attribution key. */
  route: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** LiteLLM's own computed cost for the call — the real number, not an estimate. */
  costUsd: number;
  callId: string | null;
}

/** Resolve the ledger path: AH_SPEND_LEDGER overrides; otherwise <repoPath>/.substrate/
 *  litellm-spend.jsonl. Mirrors the callback's resolution so both sides agree. */
export function ledgerPath(repoPath: string = process.cwd()): string {
  return process.env.AH_SPEND_LEDGER ?? join(repoPath, ".substrate", "litellm-spend.jsonl");
}

/** Parse a JSONL ledger blob into records. Pure — tolerant of blank/malformed lines (a partially
 *  flushed final line, a future field): a bad line is skipped, not fatal. Tested without a file. */
export function parseSpendLedger(text: string): SpendRecord[] {
  const records: SpendRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a half-written final line or junk — skip, don't throw
    }
    const cost = num(obj.costUsd);
    if (cost === null) continue; // a line with no cost carries no spend signal
    records.push({
      tsStart: num(obj.tsStart),
      tsEnd: num(obj.tsEnd),
      route: str(obj.route),
      model: str(obj.model),
      promptTokens: num(obj.promptTokens) ?? 0,
      completionTokens: num(obj.completionTokens) ?? 0,
      totalTokens: num(obj.totalTokens) ?? 0,
      costUsd: cost,
      callId: str(obj.callId),
    });
  }
  return records;
}

/** Read + parse the ledger from disk. Returns [] when the ledger doesn't exist yet (no calls
 *  logged — a fresh repo or a gateway started without the callback). */
export function readSpendLedger(path: string = ledgerPath()): SpendRecord[] {
  if (!existsSync(path)) return [];
  return parseSpendLedger(readFileSync(path, "utf-8"));
}

/**
 * Sum the real cost of calls on `route` whose window falls inside [startMs, endMs] — the
 * reconciliation primitive. Pure over the records. A call counts when its [tsStart, tsEnd] is
 * fully within the window (so a leg captures exactly the calls it made: start is stamped before
 * the leg, end after it). Records missing a timestamp are excluded (can't be placed in a window).
 */
export function spendInWindow(records: SpendRecord[], route: string, startMs: number, endMs: number): number {
  let total = 0;
  for (const r of records) {
    if (r.route !== route) continue;
    if (r.tsStart === null || r.tsEnd === null) continue;
    if (r.tsStart >= startMs && r.tsEnd <= endMs) total += r.costUsd;
  }
  return total;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
