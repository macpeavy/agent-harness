// The substrate MCP server (the router entrypoint, ADR 0017/0019). Exposes the substrate
// planning surface — `status` and `dispatch` (decompose lands with the chief) — as MCP
// tools an OpenCode agent (the chief, ADR 0012) loads over stdio. The tool logic lives in
// ./tools; this wires the service to the transport.
//
// Run (OpenCode launches it per opencode.json `mcp.substrate`):  bun run src/mcp/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PlanRepository } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import {
  runStatus,
  runDispatch,
  runDecompose,
  runMetaDecompose,
  runPromote,
  runRedecompose,
  runAddChunk,
  runAddSession,
  runAddEdge,
  runReviseChunk,
  runRemoveChunk,
  runRemoveSession,
  runRemoveEdge,
} from "./tools";

// The chunk spec the chief authors per chunk (ADR 0014). The parent sessionId is omitted —
// the handler stamps it from the session, so the chief doesn't repeat it per chunk.
const chunkSpec = z.object({
  id: z.string().describe("unique chunk id (becomes the dispatch/branch id)"),
  surface: z.string().describe("the one file this chunk produces"),
  intent: z.string().describe("one sentence: what this chunk is for"),
  contract: z.string().describe("the exact signatures/types/exports it must produce"),
  acceptance: z.string().describe("acceptance criteria, including a test file"),
  dataShapes: z.string().optional().describe("data shapes the chunk works with"),
  preResolved: z.string().optional().describe("design decisions pre-resolved to avoid amends"),
  outOfScope: z.string().optional().describe("what this chunk must NOT do"),
  tierHint: z.enum(["cheap", "strong"]).optional().describe("build tier (default cheap)"),
});

/**
 * Build the substrate MCP server over a given service — pure construction, so a test can
 * link it to an in-memory client without spawning a process.
 */
export function createSubstrateServer(service: PlanDispatchService): McpServer {
  const server = new McpServer({ name: "substrate", version: "0.1.0" });

  server.registerTool(
    "meta_decompose",
    {
      title: "Meta-decompose a feature into sessions",
      description:
        "Pass 1 of two-level decomposition (ADR 0020): write the feature + its ~1k-LOC SESSION " +
        "boundaries to the plan — no chunks yet. Each session is a reviewable unit that gets " +
        "one session-main PR. A small feature is one session; a large one is several. Then " +
        "decompose each session (the `decompose` tool) into its chunk-DAG.",
      inputSchema: {
        feature: z
          .object({
            id: z.string().describe("unique feature id"),
            title: z.string().describe("short feature title"),
            description: z.string().describe("the owner's intent"),
          })
          .describe("the feature being decomposed"),
        sessions: z
          .array(
            z.object({
              id: z.string().describe("unique session id (becomes the session-main branch id)"),
              locEstimate: z.number().optional().describe("the chief's ~1k-LOC target for this session"),
            }),
          )
          .describe("the session boundaries (one for a small feature, several for a large one)"),
      },
    },
    async (input) => runMetaDecompose(service, input),
  );

  server.registerTool(
    "decompose",
    {
      title: "Decompose a session into its chunk-DAG",
      description:
        "Pass 2 of two-level decomposition (ADR 0020): the INITIAL fill of a session — write its " +
        "chunks (each a full ADR 0014 spec) + dependency edges (`to` depends on `from`). The " +
        "session must already exist (from meta_decompose). To add ONE chunk to a session later " +
        "(during revision), use `add_chunk`, not this. Validated for cycles/unknown refs. " +
        "Plan-only — nothing dispatches until the owner approves.",
      inputSchema: {
        sessionId: z.string().describe("the session to decompose (from meta_decompose)"),
        chunks: z.array(chunkSpec).describe("the chunks of this session"),
        edges: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .describe("dependency edges — `to` depends on `from`"),
      },
    },
    async (input) => runDecompose(service, input),
  );

  // --- planning-amendable: add + revise + prune (ADR 0020 §5b) — edit the plan before approval ---

  server.registerTool(
    "add_chunk",
    {
      title: "Add a chunk to a session",
      description:
        "Add ONE chunk to an existing session before approval (ADR 0020) — the incremental add " +
        "during revision (use `decompose` for the initial fill of an empty session). Optional " +
        "edges wire it to the session's existing chunks. Validated for cycles/unknown refs. " +
        "Allowed while the feature is in planning; frozen once approved.",
      inputSchema: {
        sessionId: z.string().describe("the session to add the chunk to"),
        chunk: chunkSpec.describe("the chunk to add (a full ADR 0014 spec)"),
        edges: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .optional()
          .describe("optional edges wiring the new chunk to the session's chunks (`to` depends on `from`)"),
      },
    },
    async (input) => runAddChunk(service, input),
  );

  server.registerTool(
    "add_session",
    {
      title: "Add a session to a feature",
      description:
        "Add ONE session to an existing feature before approval (ADR 0020 §5b) — the symmetric " +
        "counterpart to `remove_session`, for when the plan needs another ~1k-LOC reviewable unit " +
        "(use `meta_decompose` for the initial set). Decompose it afterward into its chunk-DAG. " +
        "Allowed while the feature is in planning; frozen once approved.",
      inputSchema: {
        featureId: z.string().describe("the feature to add the session to"),
        sessionId: z.string().describe("unique session id (becomes the session-main branch id)"),
        locEstimate: z.number().optional().describe("the chief's ~1k-LOC target for this session"),
      },
    },
    async (input) => runAddSession(service, input),
  );

  server.registerTool(
    "add_edge",
    {
      title: "Add a dependency edge",
      description:
        "Add ONE dependency edge (`from`→`to`, `to` depends on `from`) between two chunks of the " +
        "same session before approval (ADR 0020 §5b) — the symmetric counterpart to `remove_edge`. " +
        "Rejects a self-edge, a cross-session edge, or one that would form a cycle. Allowed while " +
        "the feature is in planning.",
      inputSchema: {
        from: z.string().describe("the precursor chunk id"),
        to: z.string().describe("the dependent chunk id"),
      },
    },
    async ({ from, to }) => runAddEdge(service, from, to),
  );

  server.registerTool(
    "revise_chunk",
    {
      title: "Revise a planned chunk",
      description:
        "Re-spec a planned chunk before approval (ADR 0020) — change only the fields you pass " +
        "(e.g. just the contract). Allowed while the feature is in planning; frozen once approved.",
      inputSchema: {
        chunkId: z.string().describe("the chunk to revise"),
        surface: z.string().optional().describe("the one file this chunk produces"),
        intent: z.string().optional().describe("one sentence: what this chunk is for"),
        contract: z.string().optional().describe("the exact signatures/types/exports it must produce"),
        acceptance: z.string().optional().describe("acceptance criteria, including a test file"),
        dataShapes: z.string().optional().describe("data shapes the chunk works with"),
        preResolved: z.string().optional().describe("design decisions pre-resolved to avoid amends"),
        outOfScope: z.string().optional().describe("what this chunk must NOT do"),
        tierHint: z.enum(["cheap", "strong"]).optional().describe("build tier"),
      },
    },
    async (input) => runReviseChunk(service, input),
  );

  server.registerTool(
    "remove_chunk",
    {
      title: "Remove a planned chunk",
      description:
        "Drop a planned chunk (and any edges touching it) before approval (ADR 0020). Allowed " +
        "while the feature is in planning.",
      inputSchema: { chunkId: z.string().describe("the chunk to remove") },
    },
    async ({ chunkId }) => runRemoveChunk(service, chunkId),
  );

  server.registerTool(
    "remove_session",
    {
      title: "Remove a session",
      description:
        "Drop a session and its whole sub-plan (its chunks + edges) before approval (ADR 0020). " +
        "Allowed while the feature is in planning.",
      inputSchema: { sessionId: z.string().describe("the session to remove") },
    },
    async ({ sessionId }) => runRemoveSession(service, sessionId),
  );

  server.registerTool(
    "remove_edge",
    {
      title: "Remove a dependency edge",
      description: "Drop one dependency edge (`from`→`to`) before approval (ADR 0020). Allowed while planning.",
      inputSchema: {
        from: z.string().describe("the precursor chunk id"),
        to: z.string().describe("the dependent chunk id"),
      },
    },
    async ({ from, to }) => runRemoveEdge(service, from, to),
  );

  server.registerTool(
    "status",
    {
      title: "Feature status",
      description:
        "Read a feature's plan + dispatch status: each chunk's state and its dispatch's " +
        "state, the cheap-able-fraction readout, and the parked escalations to route.",
      inputSchema: { featureId: z.string().describe("the feature id to report on") },
    },
    async ({ featureId }) => runStatus(service, featureId),
  );

  server.registerTool(
    "dispatch",
    {
      title: "Dispatch (approve) a session for build",
      description:
        "Approve the feature for build (ADR 0020) — calling this IS the act of approval (the " +
        "feature moves planning→ready, approving the whole session plan). The session loop then " +
        "opens session-main, launches the ready chunks, and builds them into the one session " +
        "PR; you hand off and step back (use status to watch). Call it ONLY on the owner's " +
        "explicit go, never on a passing 'looks good', a guess, or silence. The owner approves " +
        "the session PR on merge.",
      inputSchema: { sessionId: z.string().describe("a session of the feature to approve for build") },
    },
    async ({ sessionId }) => runDispatch(service, sessionId),
  );

  server.registerTool(
    "promote",
    {
      title: "Tier-promote an escalated chunk",
      description:
        "Resolve a parked escalated chunk by re-dispatching it on the STRONG build tier " +
        "(the builder on the strong route). Use when the chunk is sound but too hard for " +
        "the cheap tier — not when it needs splitting (use redecompose for that).",
      inputSchema: { chunkId: z.string().describe("the escalated chunk to promote + re-dispatch") },
    },
    async ({ chunkId }) => runPromote(service, chunkId),
  );

  server.registerTool(
    "redecompose",
    {
      title: "Re-decompose an escalated chunk",
      description:
        "Resolve a parked escalated chunk by retiring it and replacing it with smaller " +
        "chunks (it was too big). Provide the replacement chunk specs and the edges among " +
        "them — and edges reconnecting the retired chunk's former dependents to the new " +
        "ones. Validated for cycles. The replacements dispatch through the normal path.",
      inputSchema: {
        chunkId: z.string().describe("the escalated chunk to retire"),
        chunks: z.array(chunkSpec).describe("the replacement chunks (featureId is inferred)"),
        edges: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .describe("dependency edges — `to` depends on `from`; may reference surviving chunks"),
      },
    },
    async (input) => runRedecompose(service, input),
  );

  return server;
}

if (import.meta.main) {
  // SUBSTRATE_DB overrides the default shared-db path — lets a smoke test point the booted
  // subprocess at a temp db instead of the repo's real one. Both repos open the same file.
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  const dispatch = dbPath ? new DispatchRepository(dbPath) : new DispatchRepository();
  const service = new PlanDispatchService(plan, dispatch);
  const server = createSubstrateServer(service);
  await server.connect(new StdioServerTransport());
}
