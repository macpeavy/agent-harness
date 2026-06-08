// The plan→dispatch service (the service layer, ADR 0017/0019/0020) — the one module allowed
// to bind the two bounded contexts. It reads a session's ready chunks from the plan,
// materialises each as a dispatch in the registry (carrying the chunk's curation so the right
// context pack injects, ADR 0018), links them, and later flows each dispatch's terminal
// outcome back onto its chunk.
//
// Two-level (ADR 0020): features → sessions → chunks. Dispatch is scoped to a SESSION; the
// owner-approval gate sits at the FEATURE (approving the whole session plan), folded into the
// first session dispatch.
//
// Layering (ADR 0017): the repositories stay independent — PlanRepository never imports
// DispatchRepository. THIS is the seam that binds them; it holds no SQL of its own, only
// repository calls. It does not drive the build loop — the daemon polls the registry and
// drives every queued dispatch; this service just materialises them and reaps outcomes.

import { dispatchBranch } from "./legs/build";
import {
  cheapAbleFraction,
  DispatchRepository,
  type Dispatch,
  type DispatchState,
  type Escalation,
  type Readout,
} from "../substrate/dispatch";
import {
  CHUNK_OUTCOMES,
  PlanRepository,
  validateDag,
  type Chunk,
  type ChunkOutcome,
  type ChunkState,
  type CreateChunk,
  type CreateMetaDecomposition,
  type DagEdge,
  type ReviseChunk,
  type FeatureState,
  type SessionState,
} from "../substrate/plan";

/** What a single materialised dispatch records back to the caller. */
export interface MaterialisedDispatch {
  chunkId: string;
  dispatchId: string;
}

/** What flowing one outcome back records to the caller. */
export interface FlowedOutcome {
  chunkId: string;
  outcome: ChunkOutcome;
}

/** What a `decompose` / `redecompose` records back to the caller. */
export interface Decomposed {
  featureId: string;
  sessionId: string;
  chunkIds: string[];
  edgeCount: number;
}

/** One chunk's progress: its own state plus its linked dispatch's state, if any. */
export interface ChunkStatus {
  id: string;
  surface: string;
  state: ChunkState;
  dispatchId: string | null;
  dispatchState: DispatchState | null;
}

/** A parked escalation surfaced for the owner to route (re-decompose / tier-promote). */
export interface ParkedEscalation {
  chunkId: string;
  dispatchId: string;
  kind: Escalation;
}

/** One session's progress: its state + PR linkage, its chunks, the readout over its
 *  dispatches, and the parked escalations within it. */
export interface SessionStatus {
  session: {
    id: string;
    state: SessionState;
    branch: string | null;
    prNumber: number | null;
    prUrl: string | null;
    locEstimate: number | null;
  };
  chunks: ChunkStatus[];
  readout: Readout;
  escalations: ParkedEscalation[];
}

/** A feature's full status (ADR 0020): the feature, then its sessions, each with its chunks,
 *  readout, and escalations. */
export interface FeatureStatus {
  feature: { id: string; title: string; state: FeatureState };
  sessions: SessionStatus[];
}

/**
 * Assemble a dispatch's build-spec from a chunk's ADR 0014 spec fields. Pure — the
 * builder works from this text; the structured curation (surface, skills) rides the
 * dispatch row's own columns, not this blob.
 */
export function specFromChunk(c: Chunk): string {
  const sections = [
    `[${c.surface}] ${c.intent}`,
    `## Contract\n${c.contract}`,
    `## Acceptance\n${c.acceptance}`,
  ];
  if (c.dataShapes) sections.push(`## Data shapes\n${c.dataShapes}`);
  if (c.preResolved) sections.push(`## Pre-resolved decisions\n${c.preResolved}`);
  if (c.outOfScope) sections.push(`## Out of scope\n${c.outOfScope}`);
  return sections.join("\n\n");
}

/**
 * The outcome a dispatch flows back onto its chunk, or null if it hasn't reached one yet.
 * A chunk's outcomes (done / escalated / failed) are exactly the dispatch states that are
 * also outcomes, so they pass through by name; the in-flight states (queued / building /
 * review / amending) flow back as null. Not a bare `return state` — DispatchState is the
 * wider union, and this narrows it to ChunkOutcome via the shared outcome set (so the two
 * can't silently drift apart).
 */
export function outcomeFor(state: DispatchState): ChunkOutcome | null {
  return (CHUNK_OUTCOMES as readonly string[]).includes(state) ? (state as ChunkOutcome) : null;
}

export class PlanDispatchService {
  constructor(
    private readonly plan: PlanRepository,
    private readonly dispatch: DispatchRepository,
  ) {}

  /**
   * Meta-decompose a feature into its sessions (ADR 0020 §2, pass 1) — the chief's first
   * pass: the feature + its ~1k-LOC session boundaries, no chunks yet. Plan-only. Each
   * session is then filled by `decompose` (pass 2). Returns the feature + session ids.
   */
  metaDecompose(input: CreateMetaDecomposition): { featureId: string; sessionIds: string[] } {
    this.plan.createMetaDecomposition(input);
    return { featureId: input.feature.id, sessionIds: input.sessions.map((s) => s.id) };
  }

  /**
   * Decompose a session into its chunk-DAG (ADR 0020 §2, pass 2) — add the chunks (each a full
   * ADR 0014 spec) + dependency edges to an existing session, in one transaction. The DAG is
   * validated up front (unknown refs, self-edges, cycles → a clear error before any write).
   * Planning-amendable: allowed while the feature is in `planning`. Nothing dispatches until
   * the owner approves and the session loop launches it.
   */
  decompose(input: { sessionId: string; chunks: Omit<CreateChunk, "sessionId">[]; edges: DagEdge[] }): Decomposed {
    const session = this.plan.getSession(input.sessionId);
    if (!session) throw new Error(`no session ${input.sessionId}`);

    const violation = validateDag(
      input.chunks.map((c) => c.id),
      input.edges,
    );
    if (violation) throw new Error(`invalid chunk-DAG: ${violation}`);

    const stamped = input.chunks.map((c) => ({ ...c, sessionId: input.sessionId }));
    this.plan.addChunkDag(input.sessionId, stamped, input.edges);
    return {
      featureId: session.featureId,
      sessionId: input.sessionId,
      chunkIds: input.chunks.map((c) => c.id),
      edgeCount: input.edges.length,
    };
  }

  /**
   * Add one chunk to an existing session before approval (ADR 0020 §5b) — the chief grows a
   * session's DAG on owner feedback. Optional edges wire the new chunk to the session's
   * existing chunks. Validated as a DAG over the session's resulting graph (acyclic, known
   * refs, no dup id) before the write. Planning-amendable (the repo gates on `planning`).
   * `decompose` is the initial pass-2 fill of an empty session; this is the incremental add.
   */
  addChunk(input: { sessionId: string; chunk: Omit<CreateChunk, "sessionId">; edges?: DagEdge[] }): {
    featureId: string;
    sessionId: string;
    chunkId: string;
  } {
    const session = this.plan.getSession(input.sessionId);
    if (!session) throw new Error(`no session ${input.sessionId}`);
    const edges = input.edges ?? [];

    const projectedIds = [...this.plan.listChunks(input.sessionId).map((c) => c.id), input.chunk.id];
    const projectedEdges = [...this.plan.listEdges(input.sessionId), ...edges];
    const violation = validateDag(projectedIds, projectedEdges);
    if (violation) throw new Error(`invalid chunk addition: ${violation}`);

    this.plan.addChunkDag(input.sessionId, [{ ...input.chunk, sessionId: input.sessionId }], edges);
    return { featureId: session.featureId, sessionId: input.sessionId, chunkId: input.chunk.id };
  }

  /**
   * Revise + prune the plan before approval (ADR 0020 §5b) — the chief iterates with the
   * owner while the feature is in `planning`. All delegate to the plan repo, which gates
   * each on the parent feature being `planning` (a built/approved plan can't be edited).
   */
  reviseChunk(chunkId: string, spec: ReviseChunk): void {
    this.plan.reviseChunk(chunkId, spec);
  }

  removeChunk(chunkId: string): void {
    this.plan.removeChunk(chunkId);
  }

  removeSession(sessionId: string): void {
    this.plan.removeSession(sessionId);
  }

  removeEdge(fromChunkId: string, toChunkId: string): void {
    this.plan.removeEdge(fromChunkId, toChunkId);
  }

  /**
   * Add a session to an existing feature before approval (ADR 0020 §5b) — the symmetric
   * counterpart to `removeSession`. Planning-amendable (the repo gates `createSession`).
   */
  addSession(featureId: string, sessionId: string, locEstimate?: number): void {
    this.plan.createSession({ id: sessionId, featureId, locEstimate });
  }

  /**
   * Add a dependency edge between two chunks of the same session before approval (ADR 0020
   * §5b) — the symmetric counterpart to `removeEdge`. Derives the session from the chunks
   * (both must be in the same one) so the chief gives just the two chunk ids; the repo's
   * `addEdge` rejects a self-edge or a cycle and gates on `planning`.
   */
  addEdge(fromChunkId: string, toChunkId: string): void {
    const from = this.plan.getChunk(fromChunkId);
    if (!from) throw new Error(`no chunk ${fromChunkId}`);
    const to = this.plan.getChunk(toChunkId);
    if (!to) throw new Error(`no chunk ${toChunkId}`);
    if (from.sessionId !== to.sessionId)
      throw new Error(`edge ${fromChunkId} → ${toChunkId} spans sessions — edges are within one session`);
    this.plan.addEdge(from.sessionId, fromChunkId, toChunkId);
  }

  /**
   * Approve a feature for build (ADR 0020 slice 2b) — the owner's gate, the chief's `dispatch`
   * call. Moves the feature `planning → ready`, which is what tells the deterministic session
   * loop it may open + launch the feature's sessions. Plan-only and fast: the chief hands off
   * and steps back; the loop does the git (session-open) and the materialisation. Idempotent —
   * approving an already-approved feature is a no-op. Takes a session id (the chief dispatches
   * a session); the whole feature's session plan is approved (ADR 0020 §6).
   */
  approve(sessionId: string): { featureId: string } {
    const session = this.plan.getSession(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) throw new Error(`no feature ${session.featureId}`);
    if (feature.state === "planning") this.plan.transitionFeature(feature.id, "ready");
    return { featureId: feature.id };
  }

  /**
   * Approve the feature (if needed) and materialise a SESSION's ready chunks as dispatches:
   * create the registry row (spec assembled from the chunk, curation carried on its own
   * columns), then link it back onto the chunk. The running daemon picks the queued rows up.
   *
   * Approval is folded in (ADR 0019/0020) and sits at the FEATURE: calling dispatch on a
   * session whose feature is still 'planning' transitions the feature planning → ready —
   * approving the whole session plan (ADR 0020 §6), freezing amendability. In attended mode
   * this IS the owner's gate; the chief calls dispatch only on the owner's explicit "go"
   * (agents/chief.md). The hard, un-self-approvable boundary is unchanged: the owner approves
   * the session PR on merge. The session advances planning → ready → building as it dispatches.
   * Returns the chunk→dispatch links created (empty if nothing is ready).
   */
  dispatchReady(sessionId: string): MaterialisedDispatch[] {
    const session = this.plan.getSession(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    const feature = this.plan.getFeature(session.featureId);
    if (!feature) throw new Error(`no feature ${session.featureId}`);

    // The conversational approval, at the feature: a planning feature is approved
    // (planning → ready) as part of dispatching one of its sessions. The plan model owns the
    // transition + its validation (ADR 0017); dispatch is just the trigger.
    let featureState = feature.state;
    if (featureState === "planning") {
      this.plan.transitionFeature(feature.id, "ready");
      featureState = "ready";
    }

    // Advance the session toward building as it starts dispatching.
    let sessionStateNow = session.state;
    if (sessionStateNow === "planning") {
      this.plan.transitionSession(sessionId, "ready");
      sessionStateNow = "ready";
    }

    const ready = this.plan.readyChunks(sessionId);
    const materialised = ready.map((chunk) => this.materialise(chunk, session.branch));

    if (materialised.length > 0) {
      if (sessionStateNow === "ready") this.plan.transitionSession(sessionId, "building");
      if (featureState === "ready") this.plan.transitionFeature(feature.id, "building");
    }

    return materialised;
  }

  /**
   * Tier-promote a parked escalated chunk and re-dispatch it on the strong build tier
   * (ADR 0019): mark the chunk 'strong', then materialise a fresh dispatch (a new id, so the
   * registry's stored branch and the build leg's derived branch still agree on one id — the
   * re-dispatch branch fix). The chunk moves escalated → dispatched. Returns the new link.
   */
  promote(escalatedChunkId: string): MaterialisedDispatch {
    const chunk = this.plan.getChunk(escalatedChunkId);
    if (!chunk) throw new Error(`no chunk ${escalatedChunkId}`);
    if (chunk.state !== "escalated")
      throw new Error(`chunk ${escalatedChunkId} is not escalated (state: ${chunk.state})`);

    this.plan.setTierHint(escalatedChunkId, "strong");
    const promoted = this.plan.getChunk(escalatedChunkId);
    if (!promoted) throw new Error(`no chunk ${escalatedChunkId}`);
    const session = this.plan.getSession(promoted.sessionId);
    return this.materialise(promoted, session?.branch ?? null);
  }

  /**
   * Re-decompose a parked escalated chunk (ADR 0019): retire it (→ superseded) and replace it
   * with smaller chunks the chief authors, validated as a DAG over the resulting SESSION graph
   * (the new chunks plus the session's surviving ones, minus the retired chunk's edges). The
   * new chunks are 'planned' with fresh ids and flow through the normal dispatch path. The
   * chief supplies any edges that reconnect the retired chunk's former dependents.
   */
  redecompose(
    escalatedChunkId: string,
    input: { chunks: Omit<CreateChunk, "sessionId">[]; edges: DagEdge[] },
  ): Decomposed {
    const chunk = this.plan.getChunk(escalatedChunkId);
    if (!chunk) throw new Error(`no chunk ${escalatedChunkId}`);
    if (chunk.state !== "escalated")
      throw new Error(`chunk ${escalatedChunkId} is not escalated (state: ${chunk.state})`);

    // No new edge may reference the retired chunk — it is leaving the active graph.
    for (const e of input.edges)
      if (e.from === escalatedChunkId || e.to === escalatedChunkId)
        throw new Error(`re-decompose: an edge references the retired chunk ${escalatedChunkId}`);

    // Project the session graph after the rewrite and validate it whole: the surviving chunks
    // (every chunk in the session except the one being retired) plus the new chunks, and the
    // surviving edges (those not touching the retired chunk) plus the new edges.
    const survivingIds = this.plan
      .listChunks(chunk.sessionId)
      .filter((c) => c.id !== escalatedChunkId)
      .map((c) => c.id);
    const survivingEdges = this.plan
      .listEdges(chunk.sessionId)
      .filter((e) => e.from !== escalatedChunkId && e.to !== escalatedChunkId);

    const projectedIds = [...survivingIds, ...input.chunks.map((c) => c.id)];
    const projectedEdges = [...survivingEdges, ...input.edges];
    const violation = validateDag(projectedIds, projectedEdges);
    if (violation) throw new Error(`invalid re-decomposition: ${violation}`);

    // Stamp the replacements with the escalated chunk's session so the chief doesn't repeat it.
    const stamped = input.chunks.map((c) => ({ ...c, sessionId: chunk.sessionId }));
    this.plan.redecompose(escalatedChunkId, stamped, input.edges);
    const session = this.plan.getSession(chunk.sessionId);
    return {
      featureId: session?.featureId ?? "",
      sessionId: chunk.sessionId,
      chunkIds: input.chunks.map((c) => c.id),
      edgeCount: input.edges.length,
    };
  }

  /**
   * Flow each dispatched chunk's terminal dispatch outcome back onto the chunk (done /
   * escalated / failed), scoped to a session. When every chunk in the session has reached a
   * terminal-success state (done / superseded), the session follows to 'done' — and when
   * every session of the feature is done, the feature follows to 'done'. Returns the
   * outcomes flowed this pass.
   */
  recordOutcomes(sessionId: string): FlowedOutcome[] {
    const session = this.plan.getSession(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);

    const flowed: FlowedOutcome[] = [];
    for (const chunk of this.plan.listChunks(sessionId)) {
      if (chunk.state !== "dispatched" || !chunk.dispatchId) continue;
      const dispatch = this.dispatch.get(chunk.dispatchId);
      if (!dispatch) continue;
      const outcome = outcomeFor(dispatch.state);
      if (!outcome) continue; // still in flight
      this.plan.recordOutcome(chunk.id, outcome);
      flowed.push({ chunkId: chunk.id, outcome });
    }

    // A session's build is complete when every chunk reached a terminal-success state — `done`,
    // or `superseded` (re-decomposed: retired, its work carried by replacements that are done).
    // A `failed` or in-flight chunk holds it open. Build-complete moves the session to `review`,
    // NOT `done` (ADR 0020 §6): its chunks are in session-main and the PR awaits the owner. The
    // owner's merge (closeSession) is the only thing that reaches `done` — the merge gate.
    const chunks = this.plan.listChunks(sessionId);
    const buildComplete = chunks.length > 0 && chunks.every((c) => c.state === "done" || c.state === "superseded");
    if (session.state === "building" && buildComplete) {
      this.plan.transitionSession(sessionId, "review");
    }

    return flowed;
  }

  /**
   * Close a session on the owner's merge (ADR 0020 §6) — the second owner gate. Moves the
   * session `review → done`; when every session of the feature is done, the feature follows.
   * This is the substrate's record of "the owner merged the session PR" — the merge itself
   * happens on GitHub, the load-bearing safety boundary. Idempotent: closing an already-done
   * session is a no-op. Throws if the session isn't in `review` (nothing built to merge yet).
   */
  closeSession(sessionId: string): { featureId: string } {
    const session = this.plan.getSession(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    if (session.state === "done") return { featureId: session.featureId }; // idempotent
    if (session.state !== "review")
      throw new Error(`session ${sessionId} is ${session.state}, not review — nothing to close`);
    this.plan.transitionSession(sessionId, "done");
    this.completeFeatureIfDone(session.featureId);
    return { featureId: session.featureId };
  }

  /**
   * A read-only digest of a feature for the owner/chief (ADR 0020 `status`): the feature, then
   * each session with its chunks, the cheap-able readout over the session's dispatches, and
   * the parked escalations to route. Cross-context read — the service is the layer allowed to
   * join the plan and the registry.
   */
  status(featureId: string): FeatureStatus {
    const feature = this.plan.getFeature(featureId);
    if (!feature) throw new Error(`no feature ${featureId}`);

    const sessions = this.plan.listSessions(featureId).map((session) => {
      const chunks = this.plan.listChunks(session.id);

      // Resolve each chunk's linked dispatch once, shared by the chunk view, the readout, and
      // the escalation scan.
      const dispatchById = new Map<string, Dispatch>();
      for (const c of chunks) {
        if (!c.dispatchId) continue;
        const d = this.dispatch.get(c.dispatchId);
        if (d) dispatchById.set(c.dispatchId, d);
      }

      const chunkStatuses: ChunkStatus[] = chunks.map((c) => ({
        id: c.id,
        surface: c.surface,
        state: c.state,
        dispatchId: c.dispatchId,
        dispatchState: (c.dispatchId && dispatchById.get(c.dispatchId)?.state) || null,
      }));

      const escalations: ParkedEscalation[] = [];
      for (const c of chunks) {
        if (!c.dispatchId) continue;
        const d = dispatchById.get(c.dispatchId);
        if (d?.state === "escalated" && d.escalated)
          escalations.push({ chunkId: c.id, dispatchId: c.dispatchId, kind: d.escalated });
      }

      return {
        session: {
          id: session.id,
          state: session.state,
          branch: session.branch,
          prNumber: session.prNumber,
          prUrl: session.prUrl,
          locEstimate: session.locEstimate,
        },
        chunks: chunkStatuses,
        readout: cheapAbleFraction([...dispatchById.values()]),
        escalations,
      };
    });

    return {
      feature: { id: feature.id, title: feature.title, state: feature.state },
      sessions,
    };
  }

  // --- internals ---

  // Advance the feature to 'done' once every one of its sessions is done.
  private completeFeatureIfDone(featureId: string): void {
    const feature = this.plan.getFeature(featureId);
    if (!feature || feature.state !== "building") return;
    const sessions = this.plan.listSessions(featureId);
    if (sessions.length > 0 && sessions.every((s) => s.state === "done"))
      this.plan.transitionFeature(featureId, "done");
  }

  /**
   * Materialise one chunk as a dispatch: a registry row (spec from the chunk, surface + tier
   * carried so the right context pack and build route apply), then link it onto the chunk.
   * Shared by the first dispatch and tier-promote re-dispatch.
   *
   * Invariant: dispatchId == issueId. The build leg derives the branch + worktree from the
   * issue id, and the registry stores that same branch for review/resume — they must agree on
   * one id. A re-dispatch gets a fresh id (chunkId-r2, …) so it doesn't collide with the prior
   * attempt's branch; first dispatch is just the chunk id.
   */
  private materialise(chunk: Chunk, sessionBranch: string | null): MaterialisedDispatch {
    const dispatchId = this.nextDispatchId(chunk.id);
    const branch = dispatchBranch({ id: dispatchId, title: chunk.intent, body: "" });
    this.dispatch.create({
      id: dispatchId,
      issueId: dispatchId,
      title: chunk.intent,
      branch,
      spec: specFromChunk(chunk),
      surface: chunk.surface,
      tier: chunk.tierHint,
      // The session-main branch the chunk builds off + merges into on clean (ADR 0020),
      // carried so the daemon merges without importing the plan. Null until slice 2's
      // session-open populates the session's branch.
      sessionBranch: sessionBranch ?? undefined,
      // No chunk.skills field yet (ADR 0019 open question) — the build leg infers skills
      // from `surface` until the chief curates them per chunk.
    });
    this.plan.linkDispatch(chunk.id, dispatchId);
    return { chunkId: chunk.id, dispatchId };
  }

  // A dispatch id free in the registry: the chunk id, suffixed on collision (a re-dispatched
  // chunk — tier-promote — needs a fresh row; the prior attempt's is parked/terminal).
  // Bounded probe; ids stay readable (a, a-r2, a-r3, …).
  private nextDispatchId(chunkId: string): string {
    if (!this.dispatch.get(chunkId)) return chunkId;
    for (let n = 2; ; n++) {
      const candidate = `${chunkId}-r${n}`;
      if (!this.dispatch.get(candidate)) return candidate;
    }
  }
}
