// The substrate MCP tool handlers (the router layer, ADR 0017/0019). Each handler adapts
// a parsed tool call → a PlanDispatchService call → an MCP CallToolResult. No logic of its
// own beyond shaping the result and turning thrown errors into tool errors (so a bad
// featureId surfaces to the chief as a tool error, not a crashed server). The substrate
// reasoning lives in the service; this is the thin surface an OpenCode agent reaches it
// through (settles ADR 0012's MCP-vs-native question).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Decomposed, FeatureStatus, PlanDispatchService, MaterialisedDispatch } from "../dispatch/plan-dispatch";
import type { CreateChunk, CreateDecomposition, CreateFeature } from "../substrate/plan";

/**
 * The `decompose` tool's input — the chief gives the feature once and each chunk's spec
 * without repeating featureId (the handler stamps it). Mirrors CreateDecomposition minus
 * that redundancy.
 */
export interface DecomposeInput {
  feature: CreateFeature;
  chunks: Omit<CreateChunk, "featureId">[];
  edges: { from: string; to: string }[];
}

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

/** Render the result of a decompose call. */
export function renderDecomposed(d: Decomposed): string {
  return (
    `Decomposed feature ${d.featureId} into ${d.chunkIds.length} chunk(s) ` +
    `(${d.edgeCount} edge(s)): ${d.chunkIds.join(", ")}.\n` +
    `Plan written. Present it and ask the owner to proceed — call dispatch only on their ` +
    `explicit go (dispatching is approving).`
  );
}

/** `decompose` — write a feature's chunk-DAG to the plan (validated; plan-only). */
export function runDecompose(service: PlanDispatchService, input: DecomposeInput): CallToolResult {
  return guard(() => {
    const decomposition: CreateDecomposition = {
      feature: input.feature,
      chunks: input.chunks.map((c) => ({ ...c, featureId: input.feature.id })),
      edges: input.edges,
    };
    return text(renderDecomposed(service.decompose(decomposition)));
  });
}

/** `status` — a read-only digest of a feature's plan + dispatch progress. */
export function runStatus(service: PlanDispatchService, featureId: string): CallToolResult {
  return guard(() => text(renderFeatureStatus(service.status(featureId))));
}

/** `dispatch` — materialise the feature's ready chunks (owner-gated by feature state). */
export function runDispatch(service: PlanDispatchService, featureId: string): CallToolResult {
  return guard(() => text(renderDispatched(service.dispatchReady(featureId), featureId)));
}

/** `promote` — tier-promote an escalated chunk to the strong build tier and re-dispatch it. */
export function runPromote(service: PlanDispatchService, chunkId: string): CallToolResult {
  return guard(() => {
    const made = service.promote(chunkId);
    return text(`Tier-promoted chunk ${made.chunkId} to strong — re-dispatched as ${made.dispatchId}.`);
  });
}

/** The `redecompose` tool's input — the escalated chunk to retire, plus its replacement
 *  chunks (featureId stamped by the service) and the edges that wire them (incl. reconnecting
 *  the retired chunk's former dependents). */
export interface RedecomposeInput {
  chunkId: string;
  chunks: Omit<CreateChunk, "featureId">[];
  edges: { from: string; to: string }[];
}

/** `redecompose` — retire an escalated chunk and replace it with smaller chunks. */
export function runRedecompose(service: PlanDispatchService, input: RedecomposeInput): CallToolResult {
  return guard(() => {
    const d = service.redecompose(input.chunkId, { chunks: input.chunks, edges: input.edges });
    return text(
      `Re-decomposed chunk ${input.chunkId} (retired) into ${d.chunkIds.length} chunk(s) ` +
        `(${d.edgeCount} edge(s)): ${d.chunkIds.join(", ")}. They dispatch through the normal path.`,
    );
  });
}
