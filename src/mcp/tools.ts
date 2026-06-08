// The substrate MCP tool handlers (the router layer, ADR 0017/0019/0020). Each handler adapts
// a parsed tool call → a PlanDispatchService call → an MCP CallToolResult. No logic of its
// own beyond shaping the result and turning thrown errors into tool errors (so a bad id
// surfaces to the chief as a tool error, not a crashed server). The substrate reasoning lives
// in the service; this is the thin surface an OpenCode agent reaches it through.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Decomposed, FeatureStatus, PlanDispatchService } from "../dispatch/plan-dispatch";
import type { CreateChunk, CreateMetaDecomposition, ReviseChunk } from "../substrate/plan";

/** The `meta_decompose` tool's input — the feature + its ~1k-LOC session boundaries (ADR 0020
 *  pass 1). No chunks yet; each session is filled by `decompose`. Mirrors CreateMetaDecomposition. */
export type MetaDecomposeInput = CreateMetaDecomposition;

/**
 * The `decompose` tool's input (ADR 0020 pass 2) — a session's chunk-DAG: each chunk's spec
 * without repeating the sessionId (the handler passes it alongside; the service stamps it).
 */
export interface DecomposeInput {
  sessionId: string;
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

  // The completion signal (ADR 0020): surface sessions that FINISHED or ESCALATED up top, so
  // the chief sees them on its next look without scanning — pull, but prominent.
  const attention: string[] = [];
  for (const sess of s.sessions) {
    if (sess.session.state === "done") attention.push(`${sess.session.id} finished — review/merge its PR`);
    else if (sess.escalations.length > 0)
      attention.push(`${sess.session.id} has ${sess.escalations.length} escalation(s) to route`);
  }
  if (attention.length > 0) lines.push(`NEEDS ATTENTION: ${attention.join("; ")}`);

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

/** `meta_decompose` — write a feature + its session boundaries to the plan (pass 1). */
export function runMetaDecompose(service: PlanDispatchService, input: MetaDecomposeInput): CallToolResult {
  return guard(() => {
    const { featureId, sessionIds } = service.metaDecompose(input);
    return text(
      `Meta-decomposed feature ${featureId} into ${sessionIds.length} session(s): ${sessionIds.join(", ")}.\n` +
        `Now decompose each session (decompose) into its chunk-DAG; then present the plan and ask the owner to proceed.`,
    );
  });
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

/** `decompose` — write a session's chunk-DAG to the plan (pass 2; validated; plan-only). */
export function runDecompose(service: PlanDispatchService, input: DecomposeInput): CallToolResult {
  return guard(() => text(renderDecomposed(service.decompose(input))));
}

/** The `add_chunk` tool's input — one chunk to add to an existing session, plus optional
 *  edges wiring it to that session's chunks. */
export interface AddChunkInput {
  sessionId: string;
  chunk: Omit<CreateChunk, "sessionId">;
  edges?: { from: string; to: string }[];
}

/** `add_chunk` — add one chunk to an existing session before approval (ADR 0020 §5b). */
export function runAddChunk(service: PlanDispatchService, input: AddChunkInput): CallToolResult {
  return guard(() => {
    const { chunkId, sessionId } = service.addChunk(input);
    return text(`Added chunk ${chunkId} to session ${sessionId} (${input.edges?.length ?? 0} edge(s)).`);
  });
}

/** `revise_chunk` — re-spec a planned chunk before approval (ADR 0020 §5b). */
export function runReviseChunk(service: PlanDispatchService, input: { chunkId: string } & ReviseChunk): CallToolResult {
  return guard(() => {
    const { chunkId, ...spec } = input;
    service.reviseChunk(chunkId, spec);
    return text(`Revised chunk ${chunkId} (${Object.keys(spec).join(", ") || "no fields"}).`);
  });
}

/** `remove_chunk` — drop a planned chunk (and its edges) before approval. */
export function runRemoveChunk(service: PlanDispatchService, chunkId: string): CallToolResult {
  return guard(() => {
    service.removeChunk(chunkId);
    return text(`Removed chunk ${chunkId} (and any edges touching it).`);
  });
}

/** `remove_session` — drop a session and its whole sub-plan before approval. */
export function runRemoveSession(service: PlanDispatchService, sessionId: string): CallToolResult {
  return guard(() => {
    service.removeSession(sessionId);
    return text(`Removed session ${sessionId} (and its chunks + edges).`);
  });
}

/** `remove_edge` — drop one dependency edge before approval. */
export function runRemoveEdge(service: PlanDispatchService, fromChunkId: string, toChunkId: string): CallToolResult {
  return guard(() => {
    service.removeEdge(fromChunkId, toChunkId);
    return text(`Removed edge ${fromChunkId} → ${toChunkId}.`);
  });
}

/** `status` — a read-only digest of a feature's sessions + their dispatch progress. */
export function runStatus(service: PlanDispatchService, featureId: string): CallToolResult {
  return guard(() => text(renderFeatureStatus(service.status(featureId))));
}

/** `dispatch` — approve the feature for build (ADR 0020 slice 2b). The session loop then opens
 *  session-main and launches the chunks; the chief hands off and steps back. */
export function runDispatch(service: PlanDispatchService, sessionId: string): CallToolResult {
  return guard(() => {
    const { featureId } = service.approve(sessionId);
    return text(
      `Approved feature ${featureId} (via session ${sessionId}). The session loop will open ` +
        `session-main, launch the ready chunks, and build them into the session PR. Use status to watch.`,
    );
  });
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
