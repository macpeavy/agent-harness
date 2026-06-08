// The substrate MCP tool handlers (the router layer, ADR 0017/0019/0020). Each handler adapts
// a parsed tool call → a PlanDispatchService call → an MCP CallToolResult. No logic of its
// own beyond shaping the result and turning thrown errors into tool errors (so a bad id
// surfaces to the chief as a tool error, not a crashed server). The substrate reasoning lives
// in the service; this is the thin surface an OpenCode agent reaches it through.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Decomposed, FeatureStatus, MaterialisedDispatch, PlanDispatchService } from "../dispatch/plan-dispatch";
import type { CreateChunk, CreateDecomposition, CreateFeature } from "../substrate/plan";

/**
 * The `decompose` tool's input — the chief gives the feature, the session it's drawing, and
 * each chunk's spec without repeating the sessionId (the handler stamps it). Mirrors
 * CreateDecomposition minus that redundancy. (Slice 1: one session; multi-session
 * meta-decomposition is the chief's job, slice 3.)
 */
export interface DecomposeInput {
  feature: CreateFeature;
  session: { id: string; locEstimate?: number };
  chunks: Omit<CreateChunk, "sessionId">[];
  edges: { from: string; to: string }[];
}

/** The `redecompose` tool's input — the escalated chunk to retire, plus its replacement
 *  chunks (sessionId stamped by the service) and the edges that wire them. */
export interface RedecomposeInput {
  chunkId: string;
  chunks: Omit<CreateChunk, "sessionId">[];
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

// Run a handler, converting any thrown error (unknown id, the owner-approval gate, an illegal
// transition, a non-amendable feature) into a tool error.
function guard(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

/** Render a feature's status as a readable digest — feature, then its sessions (ADR 0020). */
export function renderFeatureStatus(s: FeatureStatus): string {
  const lines: string[] = [`Feature ${s.feature.id} "${s.feature.title}" — ${s.feature.state}`];
  if (s.sessions.length === 0) lines.push("Sessions: none");

  for (const sess of s.sessions) {
    const pr = sess.session.prNumber ? ` PR #${sess.session.prNumber}` : "";
    const loc = sess.session.locEstimate ? ` ~${sess.session.locEstimate} LOC` : "";
    lines.push(`Session ${sess.session.id} [${sess.session.state}]${pr}${loc}`);
    lines.push(`  Chunks (${sess.chunks.length}):`);
    for (const c of sess.chunks) {
      const d = c.dispatchState ? ` [dispatch ${c.dispatchId}: ${c.dispatchState}]` : "";
      lines.push(`    ${c.id}  ${c.surface}  ${c.state}${d}`);
    }
    if (sess.escalations.length > 0) {
      lines.push(`  Parked escalations (${sess.escalations.length}) — need routing:`);
      for (const e of sess.escalations) lines.push(`    ${e.chunkId} → ${e.kind} (dispatch ${e.dispatchId})`);
    }
    const r = sess.readout;
    lines.push(
      `  Readout: ${r.reachedReady} done / ${r.escalated} escalated / ${r.failed} failed / ` +
        `${r.inFlight} in-flight; cheap-able ${r.cheapAbleFraction.toFixed(2)}; $${r.totalCostUsd.toFixed(4)} total`,
    );
  }

  return lines.join("\n");
}

/** Render the result of a dispatch call. */
export function renderDispatched(made: MaterialisedDispatch[], sessionId: string): string {
  if (made.length === 0) return `No ready chunks to dispatch for session ${sessionId}.`;
  const lines = [`Dispatched ${made.length} ready chunk(s) for session ${sessionId}:`];
  for (const m of made) lines.push(`  chunk ${m.chunkId} → dispatch ${m.dispatchId}`);
  return lines.join("\n");
}

/** Render the result of a decompose call. */
export function renderDecomposed(d: Decomposed): string {
  return (
    `Decomposed feature ${d.featureId} / session ${d.sessionId} into ${d.chunkIds.length} chunk(s) ` +
    `(${d.edgeCount} edge(s)): ${d.chunkIds.join(", ")}.\n` +
    `Plan written. Present it and ask the owner to proceed — call dispatch only on their ` +
    `explicit go (dispatching is approving).`
  );
}

/** `decompose` — write a feature + session + chunk-DAG to the plan (validated; plan-only). */
export function runDecompose(service: PlanDispatchService, input: DecomposeInput): CallToolResult {
  return guard(() => {
    const decomposition: CreateDecomposition = {
      feature: input.feature,
      session: input.session,
      chunks: input.chunks.map((c) => ({ ...c, sessionId: input.session.id })),
      edges: input.edges,
    };
    return text(renderDecomposed(service.decompose(decomposition)));
  });
}

/** `status` — a read-only digest of a feature's sessions + their dispatch progress. */
export function runStatus(service: PlanDispatchService, featureId: string): CallToolResult {
  return guard(() => text(renderFeatureStatus(service.status(featureId))));
}

/** `dispatch` — approve the feature and materialise a session's ready chunks (ADR 0020). */
export function runDispatch(service: PlanDispatchService, sessionId: string): CallToolResult {
  return guard(() => text(renderDispatched(service.dispatchReady(sessionId), sessionId)));
}

/** `promote` — tier-promote an escalated chunk to the strong build tier and re-dispatch it. */
export function runPromote(service: PlanDispatchService, chunkId: string): CallToolResult {
  return guard(() => {
    const made = service.promote(chunkId);
    return text(`Tier-promoted chunk ${made.chunkId} to strong — re-dispatched as ${made.dispatchId}.`);
  });
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
