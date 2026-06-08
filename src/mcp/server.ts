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
import { runStatus, runDispatch, runDecompose, runPromote, runRedecompose } from "./tools";

// The chunk spec the chief authors per chunk (ADR 0014). featureId is omitted — the handler
// stamps it from the feature, so the chief doesn't repeat it per chunk.
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
    "decompose",
    {
      title: "Decompose a feature",
      description:
        "Write a feature's chunk-DAG to the plan: the feature, its chunks (each a full " +
        "ADR 0014 spec — one file, contract, acceptance, pre-resolved decisions), and the " +
        "dependency edges (`to` depends on `from`; precursors built first). Validated for " +
        "cycles/unknown refs. Plan-only — nothing dispatches until the owner approves.",
      inputSchema: {
        feature: z
          .object({
            id: z.string().describe("unique feature id"),
            title: z.string().describe("short feature title"),
            description: z.string().describe("the owner's intent"),
          })
          .describe("the feature being decomposed"),
        chunks: z.array(chunkSpec).describe("the chunks (one file each)"),
        edges: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .describe("dependency edges — `to` depends on `from`"),
      },
    },
    async (input) => runDecompose(service, input),
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
      title: "Dispatch ready chunks",
      description:
        "Approve a feature and materialise its ready chunks as builds, in one step — " +
        "calling this IS the act of approval (a still-'planning' feature is moved to " +
        "ready→building). Call it ONLY on the owner's explicit go, never on a passing " +
        "'looks good', a guess, or silence. The owner still approves every PR on merge.",
      inputSchema: { featureId: z.string().describe("the feature id to dispatch ready chunks for") },
    },
    async ({ featureId }) => runDispatch(service, featureId),
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
