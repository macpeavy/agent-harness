// End-to-end test of the substrate MCP server: link the real server to an MCP client over
// an in-memory transport pair and exercise tool discovery + calls — so the registration,
// the input schemas, and the call path are covered, not just the handler functions.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
    expect(tools.map((t) => t.name).sort()).toEqual(["dispatch", "status"]);
    // The input schema is published so the chief knows the shape.
    const status = tools.find((t) => t.name === "status");
    expect(status?.inputSchema.properties).toHaveProperty("featureId");
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
