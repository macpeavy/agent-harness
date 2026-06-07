// The substrate MCP tool handlers (the router layer, ADR 0017/0019). Each handler adapts
// a parsed tool call → a PlanDispatchService call → an MCP CallToolResult. No logic of its
// own beyond shaping the result and turning thrown errors into tool errors (so a bad
// featureId surfaces to the chief as a tool error, not a crashed server). The substrate
// reasoning lives in the service; this is the thin surface an OpenCode agent reaches it
// through (settles ADR 0012's MCP-vs-native question).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FeatureStatus, PlanDispatchService, MaterialisedDispatch } from "../dispatch/plan-dispatch";

// A plain-text tool result. The chief reads text, so the handlers render a readable digest
// rather than a JSON blob.
function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

// A tool error result — the model sees it as a failed call it can react to, not a 500.
function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// Run a handler, converting any thrown error (unknown feature, illegal transition, the
// owner-approval gate) into a tool error.
function guard(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

/** Render a feature's status as a readable digest. */
export function renderFeatureStatus(s: FeatureStatus): string {
  const lines: string[] = [`Feature ${s.feature.id} "${s.feature.title}" — ${s.feature.state}`];

  lines.push(`Chunks (${s.chunks.length}):`);
  for (const c of s.chunks) {
    const dispatch = c.dispatchState ? ` [dispatch ${c.dispatchId}: ${c.dispatchState}]` : "";
    lines.push(`  ${c.id}  ${c.surface}  ${c.state}${dispatch}`);
  }

  if (s.escalations.length > 0) {
    lines.push(`Parked escalations (${s.escalations.length}) — need routing:`);
    for (const e of s.escalations) lines.push(`  ${e.chunkId} → ${e.kind} (dispatch ${e.dispatchId})`);
  } else {
    lines.push("Parked escalations: none");
  }

  const r = s.readout;
  lines.push(
    `Readout: ${r.reachedReady} done / ${r.escalated} escalated / ${r.failed} failed / ` +
      `${r.inFlight} in-flight; cheap-able ${r.cheapAbleFraction.toFixed(2)}; ` +
      `$${r.totalCostUsd.toFixed(4)} total`,
  );

  return lines.join("\n");
}

/** Render the result of a dispatch call. */
export function renderDispatched(made: MaterialisedDispatch[], featureId: string): string {
  if (made.length === 0) return `No ready chunks to dispatch for feature ${featureId}.`;
  const lines = [`Dispatched ${made.length} ready chunk(s) for feature ${featureId}:`];
  for (const m of made) lines.push(`  chunk ${m.chunkId} → dispatch ${m.dispatchId}`);
  return lines.join("\n");
}

/** `status` — a read-only digest of a feature's plan + dispatch progress. */
export function runStatus(service: PlanDispatchService, featureId: string): CallToolResult {
  return guard(() => text(renderFeatureStatus(service.status(featureId))));
}

/** `dispatch` — materialise the feature's ready chunks (owner-gated by feature state). */
export function runDispatch(service: PlanDispatchService, featureId: string): CallToolResult {
  return guard(() => text(renderDispatched(service.dispatchReady(featureId), featureId)));
}
