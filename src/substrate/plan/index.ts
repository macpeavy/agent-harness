// The plan context's public surface — what the service layer (the chief MCP, the loop)
// imports. The internal layering (model = engine, schema = persistence, repository =
// data access) stays behind this barrel.

export { PlanRepository } from "./repository";
export type { CreateFeature, CreateSession, CreateChunk, CreateMetaDecomposition, ReviseChunk, SessionLinks } from "./repository";

export {
  FEATURE_STATES,
  FEATURE_TRANSITIONS,
  SESSION_STATES,
  SESSION_TRANSITIONS,
  CHUNK_STATES,
  CHUNK_TRANSITIONS,
  TIER_HINTS,
  CHUNK_OUTCOMES,
  isChunkTerminal,
  isSessionTerminal,
  validateDag,
} from "./model";
export type { DagEdge } from "./model";
export type {
  Feature,
  NewFeature,
  Session,
  NewSession,
  Chunk,
  NewChunk,
  Edge,
  NewEdge,
  FeatureState,
  SessionState,
  ChunkState,
  TierHint,
  ChunkOutcome,
} from "./model";
