// The plan→dispatch service (the service layer, ADR 0017/0019) — the one module allowed
// to bind the two bounded contexts. It reads ready chunks from the plan, materialises
// each as a dispatch in the registry (carrying the chunk's curation so the right context
// pack injects, ADR 0018), links them, and later flows each dispatch's terminal outcome
// back onto its chunk.
//
// Layering (ADR 0017): the repositories stay independent — PlanRepository never imports
// DispatchRepository. THIS is the seam that binds them; it holds no SQL of its own, only
// repository calls. It does not drive the build loop — the daemon polls the registry and
// drives every queued dispatch (resumeIncomplete); this service just materialises them
// and reaps their outcomes, so the daemon stays pure dispatch-context.

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
  type CreateDecomposition,
  type DagEdge,
  type FeatureState,
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

/** A feature's full status: progress, the cheap-able readout, and parked escalations. */
export interface FeatureStatus {
  feature: { id: string; title: string; state: FeatureState };
  chunks: ChunkStatus[];
  readout: Readout;
  escalations: ParkedEscalation[];
}

/** What a `decompose` records back to the caller. */
export interface Decomposed {
  featureId: string;
  chunkIds: string[];
  edgeCount: number;
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
   * Write a feature's chunk-DAG to the plan (the chief's `decompose`, ADR 0019): the
   * feature, its chunks (each a full ADR 0014 spec), and the dependency edges — in one
   * transaction, so a feature never half-lands. The DAG is validated up front (unknown
   * refs, self-edges, cycles → a clear error before any write). Plan-only; nothing
   * dispatches until the owner approves the feature and `dispatchReady` runs.
   */
  decompose(input: CreateDecomposition): Decomposed {
    const violation = validateDag(
      input.chunks.map((c) => c.id),
      input.edges,
    );
    if (violation) throw new Error(`invalid chunk-DAG: ${violation}`);

    this.plan.createDecomposition(input);
    return {
      featureId: input.feature.id,
      chunkIds: input.chunks.map((c) => c.id),
      edgeCount: input.edges.length,
    };
  }

  /**
   * Approve a feature (if needed) and materialise its ready chunks as dispatches: create
   * the registry row (spec assembled from the chunk, curation carried on its own columns),
   * then link it back onto the chunk. The running daemon picks the queued rows up.
   *
   * Approval is folded in (ADR 0019): calling dispatch on a still-'planning' feature
   * transitions it planning → ready → building. In attended mode this IS the owner's gate —
   * the chief calls dispatch only on the owner's explicit conversational "go" (agents/
   * chief.md), so the act of dispatching is the act of approving. The hard, structurally
   * un-self-approvable boundary is unchanged: the owner approves every PR on GitHub (the
   * merge gate). Async approval — approving outside the chief session — is deferred to the
   * dashboard (ADR 0015), which can hold the un-self-approvable property; not a raw CLI.
   * Returns the chunk→dispatch links created (empty if nothing is ready).
   */
  dispatchReady(featureId: string): MaterialisedDispatch[] {
    const feature = this.plan.getFeature(featureId);
    if (!feature) throw new Error(`no feature ${featureId}`);

    // The conversational approval: a planning feature is approved (planning → ready) as
    // part of dispatching it. The plan model owns the transition + its validation (ADR
    // 0017); dispatch is just the trigger. Track the state locally to avoid a re-read.
    let state = feature.state;
    if (state === "planning") {
      this.plan.transitionFeature(featureId, "ready");
      state = "ready";
    }

    const ready = this.plan.readyChunks(featureId);
    const materialised = ready.map((chunk) => this.materialise(chunk));

    // First dispatch of an approved feature moves it into 'building'.
    if (materialised.length > 0 && state === "ready")
      this.plan.transitionFeature(featureId, "building");

    return materialised;
  }

  /**
   * Tier-promote a parked escalated chunk and re-dispatch it on the strong build tier
   * (ADR 0019): mark the chunk 'strong', then materialise a fresh dispatch (a new id, so
   * the registry's stored branch and the build leg's derived branch still agree on one id —
   * the re-dispatch branch fix). The chunk moves escalated → dispatched. Returns the new link.
   */
  promote(escalatedChunkId: string): MaterialisedDispatch {
    const chunk = this.plan.getChunk(escalatedChunkId);
    if (!chunk) throw new Error(`no chunk ${escalatedChunkId}`);
    if (chunk.state !== "escalated")
      throw new Error(`chunk ${escalatedChunkId} is not escalated (state: ${chunk.state})`);

    this.plan.setTierHint(escalatedChunkId, "strong");
    const promoted = this.plan.getChunk(escalatedChunkId);
    if (!promoted) throw new Error(`no chunk ${escalatedChunkId}`);
    return this.materialise(promoted);
  }

  /**
   * Re-decompose a parked escalated chunk (ADR 0019): retire it (→ superseded) and replace
   * it with smaller chunks the chief authors, validated as a DAG over the resulting feature
   * graph (the new chunks plus the existing ones, minus the retired chunk's edges). The new
   * chunks are 'planned' with fresh ids and flow through the normal dispatch path — no
   * re-dispatch branch concern (they are new units of work). The chief supplies any edges
   * that reconnect the retired chunk's former dependents to the replacements.
   */
  redecompose(
    escalatedChunkId: string,
    input: { chunks: Omit<CreateChunk, "featureId">[]; edges: DagEdge[] },
  ): Decomposed {
    const chunk = this.plan.getChunk(escalatedChunkId);
    if (!chunk) throw new Error(`no chunk ${escalatedChunkId}`);
    if (chunk.state !== "escalated")
      throw new Error(`chunk ${escalatedChunkId} is not escalated (state: ${chunk.state})`);

    // No new edge may reference the retired chunk — it is leaving the active graph.
    for (const e of input.edges)
      if (e.from === escalatedChunkId || e.to === escalatedChunkId)
        throw new Error(`re-decompose: an edge references the retired chunk ${escalatedChunkId}`);

    // Project the feature graph after the rewrite and validate it whole: the surviving
    // chunks (every chunk except the one being retired) plus the new chunks, and the
    // surviving edges (those not touching the retired chunk) plus the new edges.
    const survivingIds = this.plan
      .listChunks(chunk.featureId)
      .filter((c) => c.id !== escalatedChunkId)
      .map((c) => c.id);
    const survivingEdges = this.plan
      .listEdges(chunk.featureId)
      .filter((e) => e.from !== escalatedChunkId && e.to !== escalatedChunkId);

    const projectedIds = [...survivingIds, ...input.chunks.map((c) => c.id)];
    const projectedEdges = [...survivingEdges, ...input.edges];
    const violation = validateDag(projectedIds, projectedEdges);
    if (violation) throw new Error(`invalid re-decomposition: ${violation}`);

    // Stamp the replacements with the escalated chunk's feature so the chief doesn't repeat it.
    const stamped = input.chunks.map((c) => ({ ...c, featureId: chunk.featureId }));
    this.plan.redecompose(escalatedChunkId, stamped, input.edges);
    return {
      featureId: chunk.featureId,
      chunkIds: input.chunks.map((c) => c.id),
      edgeCount: input.edges.length,
    };
  }

  /**
   * Flow each dispatched chunk's terminal dispatch outcome back onto the chunk (done /
   * escalated / failed). Chunks whose dispatch is still in flight are left alone. When
   * every chunk in the feature has reached 'done', the feature follows to 'done'.
   * Returns the outcomes flowed this pass.
   */
  recordOutcomes(featureId: string): FlowedOutcome[] {
    const flowed: FlowedOutcome[] = [];

    for (const chunk of this.plan.listChunks(featureId)) {
      if (chunk.state !== "dispatched" || !chunk.dispatchId) continue;
      const dispatch = this.dispatch.get(chunk.dispatchId);
      if (!dispatch) continue;
      const outcome = outcomeFor(dispatch.state);
      if (!outcome) continue; // still in flight

      this.plan.recordOutcome(chunk.id, outcome);
      flowed.push({ chunkId: chunk.id, outcome });
    }

    // The feature is done when every chunk has reached a terminal-success state — `done`,
    // or `superseded` (re-decomposed: retired, its work carried by the replacement chunks,
    // which must themselves be done). A `failed` or still-in-flight chunk holds it open.
    const all = this.plan.listChunks(featureId);
    const feature = this.plan.getFeature(featureId);
    const allComplete = all.every((c) => c.state === "done" || c.state === "superseded");
    if (feature?.state === "building" && all.length > 0 && allComplete)
      this.plan.transitionFeature(featureId, "done");

    return flowed;
  }

  /**
   * A read-only digest of a feature for the owner/chief (ADR 0019 `status`): each chunk's
   * state and its linked dispatch's state, the cheap-able readout over the feature's
   * dispatches, and the parked escalations to route. Cross-context read — the service is
   * the layer allowed to join the plan and the registry.
   */
  status(featureId: string): FeatureStatus {
    const feature = this.plan.getFeature(featureId);
    if (!feature) throw new Error(`no feature ${featureId}`);
    const chunks = this.plan.listChunks(featureId);

    // Resolve each chunk's linked dispatch once, so the chunk view, the readout, and the
    // escalation scan all read the same rows.
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
      feature: { id: feature.id, title: feature.title, state: feature.state },
      chunks: chunkStatuses,
      readout: cheapAbleFraction([...dispatchById.values()]),
      escalations,
    };
  }

  // --- internals ---

  /**
   * Materialise one chunk as a dispatch: a registry row (spec from the chunk, surface +
   * tier carried so the right context pack and build route apply), then link it onto the
   * chunk. Shared by the first dispatch and tier-promote re-dispatch.
   *
   * Invariant: dispatchId == issueId. The build leg derives the branch + worktree from the
   * issue id, and the registry stores that same branch for review/resume — they must agree
   * on one id. A re-dispatch gets a fresh id (chunkId-r2, …) so it doesn't collide with the
   * prior attempt's branch; first dispatch is just the chunk id.
   */
  private materialise(chunk: Chunk): MaterialisedDispatch {
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
