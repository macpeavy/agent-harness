// The substrate MCP tool handlers (the router layer, ADR 0017/0019/0020). Each handler adapts
// a parsed tool call → a PlanDispatchService call → an MCP CallToolResult. No logic of its
// own beyond shaping the result and turning thrown errors into tool errors (so a bad id
// surfaces to the chief as a tool error, not a crashed server). The substrate reasoning lives
// in the service; this is the thin surface an OpenCode agent reaches it through.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AddressReviewResult,
  BuildDirectInput,
  Decomposed,
  FeatureStatus,
  OwnerReviewComment,
  PlanDispatchService,
} from "../dispatch/plan-dispatch";
import type { CreateChunk, CreateMetaDecomposition, ReviseChunk } from "../substrate/plan";
import { budgetFromEstimate, type FeatureEstimate } from "../dispatch/budget";
import { formatAge, type DriverHealth } from "../dispatch/heartbeat";
import type { BudgetConfig } from "../budget-config";

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Reads a session PR's review comments off GitHub — injected so the handler stays testable
 *  (the real impl is the PR-review leg bound to config; a test passes a fake). */
export type PrReviewReader = (prNumber: number) => Promise<OwnerReviewComment[]>;

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

// The async form, for a handler that does I/O (the PR-review read) before touching the service.
async function guardAsync(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

/** Render a feature's status as a readable digest — feature, then its sessions (ADR 0020). */
export function renderFeatureStatus(s: FeatureStatus, drivers: DriverHealth[] = []): string {
  const budget = s.feature.budgetUsd !== null ? ` — budget ${usd(s.feature.budgetUsd)}` : "";
  const lines: string[] = [`Feature ${s.feature.id} "${s.feature.title}" — ${s.feature.state}${budget}`];
  if (s.sessions.length === 0) lines.push("Sessions: none");

  // The completion signal (ADR 0020): surface sessions AWAITING REVIEW or ESCALATED up top, so
  // the chief sees them on its next look without scanning — pull, but prominent. A session in
  // `review` is build-complete with its PR open for the owner to review/merge (NOT `done` —
  // `done` means the owner already merged it, ADR 0020 §6).
  const attention: string[] = [];
  // Driver liveness first (AGENT-44): with a dead driver, every in-flight state below is
  // suspect — `building` means "was building when the driver died", not healthy progress.
  // Tell the owner; don't wait on work that cannot advance.
  for (const d of drivers) {
    if (d.stale)
      attention.push(
        `driver '${d.driver}' appears DOWN (last heartbeat ${formatAge(d.ageMs)} ago, pid ${d.pid}) — ` +
          `in-flight work will not advance; tell the owner to restart it (make up)`,
      );
  }
  for (const sess of s.sessions) {
    if (sess.session.state === "review") {
      const pr = sess.session.prNumber ? ` (PR #${sess.session.prNumber})` : "";
      attention.push(`${sess.session.id} awaiting your review${pr} — review/merge its PR`);
    } else if (sess.session.budgetExceededUsd !== null) {
      // Budget-parked (ADR 0026 decision 2): the feature crossed its budget. Work already merged
      // into session-main is preserved (ship-partial = merge the PR). Owner's call to route.
      attention.push(
        `${sess.session.id} BUDGET exceeded (spent ${usd(sess.session.budgetExceededUsd)}` +
          `${s.feature.budgetUsd !== null ? ` / budget ${usd(s.feature.budgetUsd)}` : ""}) — ` +
          `raise_budget to continue / merge the PR to ship what's done / abandon. Nothing built is lost.`,
      );
    } else if (sess.session.state === "needs-attention") {
      // A chunk parked/failed and the session stopped (ADR 0023 row 7) — route it so the DAG
      // can resume. The parked chunk's reason shows in the per-session escalations below.
      const n = sess.escalations.length;
      attention.push(`${sess.session.id} needs attention — ${n} parked chunk(s) to route (redecompose/promote)`);
    } else if (sess.escalations.length > 0)
      attention.push(`${sess.session.id} has ${sess.escalations.length} escalation(s) to route`);
    // A recurring session-loop tick error (the loop caught it and kept going) — surface it so
    // the chief notices a stuck session it may want to abandon, rather than only in the logs.
    if (sess.session.lastError) attention.push(`${sess.session.id} tick error: ${sess.session.lastError}`);
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
      for (const e of sess.escalations)
        lines.push(`    ${e.chunkId} → ${e.kind} (dispatch ${e.dispatchId})${e.reason ? ` — ${e.reason}` : ""}`);
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

/** `build_direct` — the small-feature path (ADR 0026 decision 4): write the feature as ONE
 *  session + ONE chunk, no decomposition. Plan-only — dispatch stays the separate owner gate. */
export function runBuildDirect(service: PlanDispatchService, input: BuildDirectInput): CallToolResult {
  return guard(() => {
    const { featureId, sessionId, chunkId } = service.buildDirect(input);
    const tier = input.chunk.tierHint ?? "cheap";
    return text(
      `Build-direct: feature ${featureId} written as ONE chunk ${chunkId} in session ${sessionId} ` +
        `(${tier} tier, no decomposition pass — one builder + one review).\n` +
        `Plan written. Present it and ask the owner to proceed — call dispatch only on their ` +
        `explicit go (dispatching is approving).`,
    );
  });
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

/** The `add_session` tool's input — a new session to add to an existing feature. */
export interface AddSessionInput {
  featureId: string;
  sessionId: string;
  locEstimate?: number;
}

/** `add_session` — add a session to an existing feature before approval (ADR 0020 §5b). */
export function runAddSession(service: PlanDispatchService, input: AddSessionInput): CallToolResult {
  return guard(() => {
    service.addSession(input.featureId, input.sessionId, input.locEstimate);
    const loc = input.locEstimate ? ` (~${input.locEstimate} LOC)` : "";
    return text(`Added session ${input.sessionId} to feature ${input.featureId}${loc}. Decompose it into its chunk-DAG.`);
  });
}

/** `add_edge` — add one dependency edge between two chunks of a session before approval. */
export function runAddEdge(service: PlanDispatchService, fromChunkId: string, toChunkId: string): CallToolResult {
  return guard(() => {
    service.addEdge(fromChunkId, toChunkId);
    return text(`Added edge ${fromChunkId} → ${toChunkId}.`);
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
export function runStatus(
  service: PlanDispatchService,
  featureId: string,
  driverHealth?: () => DriverHealth[],
): CallToolResult {
  return guard(() => text(renderFeatureStatus(service.status(featureId), driverHealth?.() ?? [])));
}

/** Render a feature estimate for the chief to present at the gate (ADR 0026 decision 2). */
export function renderEstimate(featureId: string, est: FeatureEstimate, budgetUsd: number): string {
  return (
    `Estimate for feature ${featureId}: ${usd(est.estimateUsd)} to build ` +
    `(${est.chunkCount} chunk(s) × ${usd(est.perChunkUsd)} + ${usd(est.decompositionUsd)} decomposition).\n` +
    `Per-leg averages used: build ${usd(est.averages.build)} / review ${usd(est.averages.review)} / ` +
    `amend ${usd(est.averages.amend)} (real history where available, else seeds).\n` +
    `On dispatch the budget will be set to ${usd(budgetUsd)} (estimate × headroom); a runtime overspend ` +
    `parks the feature for you to raise/ship-partial/abandon — it is never hard-killed. Present "$X to build, go?".`
  );
}

/** `estimate` — the pre-flight gate forecast (ADR 0026 decision 2): "$X to build, go?". A
 *  forecast from real historical per-leg averages, NOT recorded spend. */
export function runEstimate(service: PlanDispatchService, featureId: string, cfg: BudgetConfig): CallToolResult {
  return guard(() => {
    const est = service.estimateFeature(featureId, cfg);
    return text(renderEstimate(featureId, est, budgetFromEstimate(est.estimateUsd, cfg)));
  });
}

/** `dispatch` — approve the feature for build (ADR 0020 slice 2b) AND lock its budget to
 *  estimate × headroom (ADR 0026 decision 2), so the runtime guard has a ceiling. The session
 *  loop then opens session-main and launches the chunks; the chief hands off and steps back. */
export function runDispatch(service: PlanDispatchService, sessionId: string, cfg: BudgetConfig): CallToolResult {
  return guard(() => {
    const { featureId } = service.approve(sessionId);
    // Lock the budget from the estimate at the gate the owner just cleared (ADR 0026).
    const est = service.estimateFeature(featureId, cfg);
    const budgetUsd = budgetFromEstimate(est.estimateUsd, cfg);
    service.setBudget(featureId, budgetUsd);
    return text(
      `Approved feature ${featureId} (via session ${sessionId}); budget set to ${usd(budgetUsd)} ` +
        `(estimate ${usd(est.estimateUsd)} × headroom). The session loop will open session-main, launch the ` +
        `ready chunks, and build them into the session PR. A runtime overspend parks (never hard-kills) — ` +
        `raise_budget to continue. Use status to watch.`,
    );
  });
}

/** `raise_budget` — raise a budget-parked feature's ceiling and resume it (ADR 0026 decision 2,
 *  the "continue" choice). Clears the budget park; a chunk-blocked session stays for the chief. */
export function runRaiseBudget(service: PlanDispatchService, featureId: string, budgetUsd: number): CallToolResult {
  return guard(() => {
    const { resumed } = service.raiseBudget(featureId, budgetUsd);
    return text(
      `Raised feature ${featureId} budget to ${usd(budgetUsd)}. ` +
        (resumed.length > 0
          ? `Resumed ${resumed.length} budget-parked session(s): ${resumed.join(", ")} — building continues.`
          : `No budget-parked sessions resumed (none were budget-parked, or a chunk still needs routing).`),
    );
  });
}

/** Render the result of an `address_review` call for the chief. */
export function renderAddressReview(r: AddressReviewResult): string {
  const lines: string[] = [`Read the owner's review on session ${r.sessionId}.`];
  if (r.reopened.length > 0)
    lines.push(
      `Reopened ${r.reopened.length} chunk(s) to amend — the daemon amends each and re-merges into ` +
        `session-main, updating the PR: ${r.reopened.map((x) => x.chunkId).join(", ")}.`,
    );
  else lines.push("No chunk amends triggered.");
  if (r.unrouted.length > 0) {
    lines.push(`${r.unrouted.length} note(s) need your judgment (not auto-routed):`);
    for (const u of r.unrouted) {
      const where = u.path ? `${u.path}: ` : "";
      lines.push(`  - [${u.reason}] ${where}${u.body.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

/** `address_review` — read the session PR's review off GitHub and route it into the amend cycle
 *  (ADR 0020 slice 4b): inline comments reopen their chunk to amend; general/unroutable notes
 *  come back for the chief's judgment. Owner-triggered; the substrate reads all the notes. */
export async function runAddressReview(
  service: PlanDispatchService,
  readPr: PrReviewReader | undefined,
  sessionId: string,
): Promise<CallToolResult> {
  return guardAsync(async () => {
    if (!readPr) return toolError("address_review is not configured with a PR reader on this server");
    const prNumber = service.sessionPrNumber(sessionId);
    const comments = await readPr(prNumber);
    return text(renderAddressReview(service.addressReview(sessionId, comments)));
  });
}

/** `close_session` — record the owner's merge of the session PR (ADR 0020 §6): session
 *  `review → done`, completing the feature when its last session merges. The merge is on
 *  GitHub (the gate); this is the substrate's record of it. */
export function runCloseSession(service: PlanDispatchService, sessionId: string): CallToolResult {
  return guard(() => {
    // notifyChief: false — the chief IS the caller here; pushing it the news it just
    // recorded would be noise. The loop's merged-PR auto-close uses the notifying default.
    const { featureId } = service.closeSession(sessionId, { notifyChief: false });
    return text(`Closed session ${sessionId} (owner merged its PR). Feature ${featureId} advances if it was its last.`);
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
