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
import { DispatchRepository, type DispatchState } from "../substrate/dispatch";
import { CHUNK_OUTCOMES, PlanRepository, type Chunk, type ChunkOutcome } from "../substrate/plan";

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
   * Materialise every ready chunk of an owner-approved feature as a dispatch: create the
   * registry row (spec assembled from the chunk, curation carried on its own columns),
   * then link it back onto the chunk. The running daemon picks the queued rows up.
   *
   * The owner-approval gate is the feature state (ADR 0019): a feature must be 'ready'
   * (or already 'building') to dispatch — a still-'planning' feature hasn't been approved.
   * Returns the chunk→dispatch links created (empty if nothing is ready).
   */
  dispatchReady(featureId: string): MaterialisedDispatch[] {
    const feature = this.plan.getFeature(featureId);
    if (!feature) throw new Error(`no feature ${featureId}`);
    if (feature.state === "planning")
      throw new Error(`feature ${featureId} is not owner-approved for dispatch (state 'planning')`);

    const ready = this.plan.readyChunks(featureId);
    const materialised: MaterialisedDispatch[] = [];

    for (const chunk of ready) {
      // Invariant: dispatchId == issueId == chunkId. The build leg re-derives the branch
      // from issue.id, and the registry stores that same branch for the review/resume to
      // read — they must agree on one id. Re-dispatching a chunk (the escalation loop)
      // means a second build of the same id, whose branch/PR-reuse strategy is unresolved;
      // that's the next slice. Until then a collision is an explicit error, not a silent
      // branch mismatch.
      const dispatchId = chunk.id;
      if (this.dispatch.get(dispatchId))
        throw new Error(
          `chunk ${chunk.id} already has dispatch ${dispatchId}; re-dispatch (escalation loop) is a later slice`,
        );
      const branch = dispatchBranch({ id: dispatchId, title: chunk.intent, body: "" });
      this.dispatch.create({
        id: dispatchId,
        issueId: chunk.id,
        title: chunk.intent,
        branch,
        spec: specFromChunk(chunk),
        surface: chunk.surface,
        // Skill curation rides the chunk's own field once it has one (ADR 0019 open
        // question); until then the build leg infers from `surface`. No chunk.skills yet,
        // so nothing to carry — left undefined, not invented.
      });
      this.plan.linkDispatch(chunk.id, dispatchId);
      materialised.push({ chunkId: chunk.id, dispatchId });
    }

    // First dispatch of an approved feature moves it into 'building'.
    if (materialised.length > 0 && feature.state === "ready")
      this.plan.transitionFeature(featureId, "building");

    return materialised;
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

    const all = this.plan.listChunks(featureId);
    const feature = this.plan.getFeature(featureId);
    if (feature?.state === "building" && all.length > 0 && all.every((c) => c.state === "done"))
      this.plan.transitionFeature(featureId, "done");

    return flowed;
  }
}
