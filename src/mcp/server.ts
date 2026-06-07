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
import { runStatus, runDispatch } from "./tools";

/**
 * Build the substrate MCP server over a given service — pure construction, so a test can
 * link it to an in-memory client without spawning a process.
 */
export function createSubstrateServer(service: PlanDispatchService): McpServer {
  const server = new McpServer({ name: "substrate", version: "0.1.0" });

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
        "Materialise every ready chunk of an owner-approved feature (state 'ready') as a " +
        "dispatch the build loop will drive. Gated: a still-'planning' feature is refused.",
      inputSchema: { featureId: z.string().describe("the feature id to dispatch ready chunks for") },
    },
    async ({ featureId }) => runDispatch(service, featureId),
  );

  return server;
}

if (import.meta.main) {
  const plan = new PlanRepository();
  const dispatch = new DispatchRepository();
  const service = new PlanDispatchService(plan, dispatch);
  const server = createSubstrateServer(service);
  await server.connect(new StdioServerTransport());
}
