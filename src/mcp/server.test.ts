// End-to-end test of the substrate MCP server: link the real server to an MCP client over
// an in-memory transport pair and exercise tool discovery + calls — so the registration,
// the input schemas, and the call path are covered, not just the handler functions.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSubstrateServer } from "./server";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import { PlanRepository, type CreateChunk } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";

let dir: string;
let plan: PlanRepository;
let dispatch: DispatchRepository;
let service: PlanDispatchService;
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ah-mcp-"));
  const dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
  service = new PlanDispatchService(plan, dispatch);

  const server = createSubstrateServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  plan.close();
  dispatch.close();
  rmSync(dir, { recursive: true, force: true });
});

const FEATURE = { id: "F1", title: "A feature", description: "the owner's intent" };

function chunk(id: string, over: Partial<CreateChunk> = {}): CreateChunk {
  return {
    id,
    featureId: "F1",
    surface: `src/${id}.ts`,
    intent: `do ${id}`,
    contract: `export function ${id}(): void`,
    acceptance: `${id}.test.ts passes`,
    ...over,
  };
}

// The text body of a tool call result (the first text content block).
async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return res.content.map((c) => c.text ?? "").join("\n");
}

async function isError(name: string, args: Record<string, unknown>): Promise<boolean> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
  return res.isError === true;
}

describe("tool discovery", () => {
  it("exposes status and dispatch", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["decompose", "dispatch", "status"]);
    // The input schema is published so the chief knows the shape.
    const status = tools.find((t) => t.name === "status");
    expect(status?.inputSchema.properties).toHaveProperty("featureId");
    const decompose = tools.find((t) => t.name === "decompose");
    expect(decompose?.inputSchema.properties).toHaveProperty("chunks");
  });
});

describe("decompose", () => {
  const DECOMP = {
    feature: { id: "F1", title: "A feature", description: "the owner's intent" },
    chunks: [
      { id: "a", surface: "src/a.ts", intent: "do a", contract: "export function a(): void", acceptance: "a.test.ts" },
      { id: "b", surface: "src/b.ts", intent: "do b", contract: "export function b(): void", acceptance: "b.test.ts" },
    ],
    edges: [{ from: "a", to: "b" }],
  };

  it("writes the chunk-DAG to the plan", async () => {
    const body = await callText("decompose", DECOMP);
    expect(body).toContain("Decomposed feature F1 into 2 chunk(s) (1 edge(s)): a, b");
    expect(body).toContain("Awaiting owner approval");
    expect(plan.listChunks("F1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.getChunk("a")?.featureId).toBe("F1"); // featureId stamped from the feature
  });

  it("returns a tool error for a cyclic DAG (and writes nothing)", async () => {
    const cyclic = { ...DECOMP, edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    expect(await isError("decompose", cyclic)).toBe(true);
    expect(plan.getFeature("F1")).toBeNull();
  });

  it("returns a tool error for an unknown-chunk edge", async () => {
    const bad = { ...DECOMP, edges: [{ from: "a", to: "ghost" }] };
    expect(await isError("decompose", bad)).toBe(true);
  });
});

describe("status", () => {
  it("reports a feature's chunks and escalations", async () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.transitionFeature("F1", "ready");
    service.dispatchReady("F1");

    const body = await callText("status", { featureId: "F1" });
    expect(body).toContain('Feature F1 "A feature" — building');
    expect(body).toContain("a  src/a.ts");
    expect(body).toContain("Parked escalations: none");
  });

  it("returns a tool error for an unknown feature", async () => {
    expect(await isError("status", { featureId: "ghost" })).toBe(true);
  });
});

describe("dispatch", () => {
  it("materialises ready chunks of an approved feature", async () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));
    plan.transitionFeature("F1", "ready");

    const body = await callText("dispatch", { featureId: "F1" });
    expect(body).toContain("Dispatched 2 ready chunk(s)");
    expect(dispatch.get("a")?.state).toBe("queued");
    expect(plan.getChunk("a")?.state).toBe("dispatched");
  });

  it("refuses (tool error) to dispatch a still-'planning' feature — the owner gate", async () => {
    plan.createFeature(FEATURE);
    plan.addChunk(chunk("a"));

    expect(await isError("dispatch", { featureId: "F1" })).toBe(true);
    expect(plan.getChunk("a")?.state).toBe("planned"); // untouched
  });
});

// The launch path is the real risk for an MCP server (a tool can unit-test green yet not
// appear over the actual stdio boot OpenCode uses). Spawn the real subprocess the way
// opencode.json does and confirm the tool list — pointing it at a temp db via SUBSTRATE_DB.
describe("stdio smoke-boot", () => {
  it("boots as a subprocess and lists all three tools", async () => {
    const smokeDir = mkdtempSync(join(tmpdir(), "ah-mcp-stdio-"));
    const env: Record<string, string> = { SUBSTRATE_DB: join(smokeDir, "substrate.db") };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

    const transport = new StdioClientTransport({ command: "bun", args: ["run", "src/mcp/server.ts"], env });
    const smokeClient = new Client({ name: "smoke", version: "0.0.0" });
    try {
      await smokeClient.connect(transport);
      const { tools } = await smokeClient.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["decompose", "dispatch", "status"]);
    } finally {
      await smokeClient.close();
      rmSync(smokeDir, { recursive: true, force: true });
    }
  });
});
