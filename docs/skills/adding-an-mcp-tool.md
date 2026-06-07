---
name: adding-an-mcp-tool
description: Use when adding a tool to the substrate MCP server (the surface the chief reaches the substrate through) — or, rarely, standing up a new MCP server. Covers the layering, the result convention, and the load-bearing validation.
---

# Adding an MCP tool

**When:** the chief (or another OpenCode agent) needs a new substrate capability — e.g.
`decompose` joins `status`/`dispatch`. The substrate MCP server (`src/mcp/`, ADR
0012/0019) is the seam an OpenCode agent reaches our code through. Adding a *tool* to the
existing server needs no new ADR (0019 is the decision of record); **standing up a new
server, or moving to `structuredContent`/`outputSchema`, is a `/chief` ADR call** — flag
it, don't improvise.

**Files:** `src/mcp/tools.ts` (the handler), `src/mcp/server.ts` (register it),
`src/mcp/server.test.ts` (validate it), and the **service layer** for the actual logic
(e.g. `src/dispatch/plan-dispatch.ts`). A new server also touches `opencode.json`
(`mcp.<name>`).

## How

1. **Put the logic in the service layer, not the tool.** The MCP is the router (ADR
   0017): a handler adapts a parsed call → a service method → a result, and nothing more.
   New behavior is a method on the service (`PlanDispatchService`), unit-tested there.
2. **Write the handler in `tools.ts`** — parse args, call the service, render a **readable
   text digest** (the chief reads text; `structuredContent` is deferred until a tool needs
   machine-parseable output). Wrap the body in `guard()` so a thrown error (unknown id,
   the owner-approval gate, an illegal transition) becomes a **tool error** the model can
   react to — never a crashed server.
3. **Register it in `server.ts`** with `server.registerTool(name, {title, description,
   inputSchema}, handler)`. `inputSchema` is a Zod shape with `.describe()` on each field.
   The **description is what the chief reads to know when and how to call the tool** —
   write it for the model, concretely.
4. **Keep `createSubstrateServer(service)` pure construction** (no process), so a test can
   link it to an in-memory client; the `import.meta.main` block wires the real service to
   the stdio transport.
5. **Validate end-to-end — this is the load-bearing part.** The launch/discovery path is
   the real risk for an MCP server, so cover both:
   - **In-memory client** (`@modelcontextprotocol/sdk` client over an in-memory transport):
     assert the tool is **listed** (discovery), a successful call returns the expected
     digest, **and both error paths** surface as tool errors.
   - **Stdio smoke-boot**: spawn the actual `bun run src/mcp/server.ts` subprocess the way
     OpenCode launches it and confirm its tool list includes the new tool. A tool that
     unit-tests green but doesn't appear over the real launch path is the failure mode this
     catches.

## Worked example (the `status` tool, `src/mcp/`)

Handler (`tools.ts`) — thin, guarded, text digest:

```ts
export function runStatus(service: PlanDispatchService, featureId: string): CallToolResult {
  return guard(() => text(renderFeatureStatus(service.status(featureId))));
}
```

Registration (`server.ts`):

```ts
server.registerTool(
  "status",
  {
    title: "Feature status",
    description: "Read a feature's plan + dispatch status: each chunk's state, the " +
      "cheap-able-fraction readout, and the parked escalations to route.",
    inputSchema: { featureId: z.string().describe("the feature id to report on") },
  },
  async ({ featureId }) => runStatus(service, featureId),
);
```

Adding `decompose` follows the same path: a `decompose` method on the service (writes the
chunk-DAG to the plan), a guarded `runDecompose` handler rendering a digest, a
`registerTool("decompose", …)` with a Zod input, and the in-memory + stdio tests extended
to cover it.

## Standing up a new server (rare)

A new `src/mcp/<name>/` with its own `createXServer` + `import.meta.main`, plus an
`opencode.json` entry: `"mcp": { "<name>": { "type": "local", "command": ["bun", "run",
"src/mcp/<name>/server.ts"], "enabled": true } }`. This is the `/chief` ADR call noted
above — surface it before building.
