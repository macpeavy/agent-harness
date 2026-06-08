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
// A fake PR-review reader the address_review tests control: it records the PR it was asked
// for and returns the canned comments — so the tool is exercised without touching GitHub.
let prReadFor: number[];
let prComments: { path: string | null; body: string; author?: string }[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ah-mcp-"));
  const dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
  service = new PlanDispatchService(plan, dispatch);

  prReadFor = [];
  prComments = [];
  const server = createSubstrateServer(service, {
    async readPrReview(prNumber) {
      prReadFor.push(prNumber);
      return prComments;
    },
  });
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

// A feature + one session (S1), both planning — the common fixture for the chief tools.
function seedFeatureSession(): void {
  plan.createFeature(FEATURE);
  plan.createSession({ id: "S1", featureId: "F1" });
}

function chunk(id: string, over: Partial<CreateChunk> = {}): CreateChunk {
  return {
    id,
    sessionId: "S1",
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

// Escalate a chunk's dispatch the way the daemon would, so the chief tools can resolve it.
function escalate(chunkId: string): void {
  dispatch.transition(chunkId, "building");
  dispatch.escalate(chunkId, "re-decompose");
  plan.recordOutcome(chunkId, "escalated"); // the service stands in for the daemon reap here
}

describe("tool discovery", () => {
  it("exposes the full chief toolset", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_chunk",
      "add_edge",
      "add_session",
      "address_review",
      "close_session",
      "decompose",
      "dispatch",
      "meta_decompose",
      "promote",
      "redecompose",
      "remove_chunk",
      "remove_edge",
      "remove_session",
      "revise_chunk",
      "status",
    ]);
    const dispatchTool = tools.find((t) => t.name === "dispatch");
    expect(dispatchTool?.inputSchema.properties).toHaveProperty("sessionId");
    const meta = tools.find((t) => t.name === "meta_decompose");
    expect(meta?.inputSchema.properties).toHaveProperty("sessions");
  });
});

describe("meta_decompose + decompose (two-level, ADR 0020)", () => {
  const CHUNKS = [
    { id: "a", surface: "src/a.ts", intent: "do a", contract: "export function a(): void", acceptance: "a.test.ts" },
    { id: "b", surface: "src/b.ts", intent: "do b", contract: "export function b(): void", acceptance: "b.test.ts" },
  ];

  it("meta-decomposes into sessions, then decomposes a session's DAG", async () => {
    const meta = await callText("meta_decompose", { feature: FEATURE, sessions: [{ id: "S1", locEstimate: 800 }, { id: "S2" }] });
    expect(meta).toContain("Meta-decomposed feature F1 into 2 session(s): S1, S2");
    expect(plan.listSessions("F1").map((s) => s.id)).toEqual(["S1", "S2"]);

    const body = await callText("decompose", { sessionId: "S1", chunks: CHUNKS, edges: [{ from: "a", to: "b" }] });
    expect(body).toContain("Decomposed feature F1 / session S1 into 2 chunk(s) (1 edge(s)): a, b");
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.getChunk("a")?.sessionId).toBe("S1"); // sessionId stamped
  });

  it("decompose returns a tool error for a cyclic DAG (and writes nothing)", async () => {
    await callText("meta_decompose", { feature: FEATURE, sessions: [{ id: "S1" }] });
    const cyclic = { sessionId: "S1", chunks: CHUNKS, edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    expect(await isError("decompose", cyclic)).toBe(true);
    expect(plan.listChunks("S1")).toEqual([]);
  });

  it("decompose returns a tool error for an unknown session", async () => {
    expect(await isError("decompose", { sessionId: "ghost", chunks: CHUNKS, edges: [] })).toBe(true);
  });
});

describe("status", () => {
  it("reports a feature's sessions, chunks, and escalations", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    service.dispatchReady("S1");

    const body = await callText("status", { featureId: "F1" });
    expect(body).toContain('Feature F1 "A feature" — building');
    expect(body).toContain("Session S1 [building]");
    expect(body).toContain("a  src/a.ts");
  });

  it("surfaces a build-complete session as awaiting the owner's review (the completion signal)", async () => {
    seedFeatureSession();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 7, prUrl: "http://pr/7" });
    plan.addChunk(chunk("a"));
    service.dispatchReady("S1");
    // Drive the chunk's dispatch to done the way the daemon would, then reap it.
    dispatch.transition("a", "building");
    dispatch.transition("a", "review");
    dispatch.transition("a", "done");
    service.recordOutcomes("S1");

    const body = await callText("status", { featureId: "F1" });
    expect(body).toContain("NEEDS ATTENTION: S1 awaiting your review (PR #7) — review/merge its PR");
    expect(body).toContain("Session S1 [review]");
  });

  it("returns a tool error for an unknown feature", async () => {
    expect(await isError("status", { featureId: "ghost" })).toBe(true);
  });
});

describe("dispatch", () => {
  it("approves the feature for build (calling dispatch IS the go; the loop launches it)", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));

    const body = await callText("dispatch", { sessionId: "S1" });
    expect(body).toContain("Approved feature F1");
    expect(plan.getFeature("F1")?.state).toBe("ready"); // approved; the loop (not dispatch) launches
    expect(plan.getChunk("a")?.state).toBe("planned"); // dispatch no longer materialises directly
  });

  it("returns a tool error for an unknown session", async () => {
    expect(await isError("dispatch", { sessionId: "ghost" })).toBe(true);
  });
});

describe("address_review + close_session (owner-review loop, ADR 0020 slice 4b)", () => {
  // Drive S1 to `review` with chunk a built + merged and a PR linked.
  function sessionInReview(): void {
    seedFeatureSession();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 7, prUrl: "http://pr/7" });
    plan.addChunk(chunk("a"));
    service.dispatchReady("S1");
    dispatch.transition("a", "building");
    dispatch.transition("a", "review");
    dispatch.transition("a", "done");
    service.recordOutcomes("S1");
  }

  it("reads the PR and reopens the touched chunk to amend", async () => {
    sessionInReview();
    prComments = [{ path: "src/a.ts", body: "rename foo to bar", author: "owner" }];

    const body = await callText("address_review", { sessionId: "S1" });
    expect(prReadFor).toEqual([7]); // read the session's PR
    expect(body).toContain("Reopened 1 chunk(s) to amend");
    expect(body).toContain("a");
    expect(dispatch.get("a")?.state).toBe("amending");
    expect(dispatch.get("a")?.pendingFindings).toContain("rename foo to bar");
  });

  it("surfaces a general note for the chief's judgment without reopening", async () => {
    sessionInReview();
    prComments = [{ path: null, body: "rethink the API shape" }];

    const body = await callText("address_review", { sessionId: "S1" });
    expect(body).toContain("need your judgment");
    expect(body).toContain("rethink the API shape");
    expect(dispatch.get("a")?.state).toBe("done"); // untouched
  });

  it("errors addressing a session that isn't in review", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    expect(await isError("address_review", { sessionId: "S1" })).toBe(true);
  });

  it("close_session records the owner's merge (review → done)", async () => {
    sessionInReview();
    const body = await callText("close_session", { sessionId: "S1" });
    expect(body).toContain("Closed session S1");
    expect(plan.getSession("S1")?.state).toBe("done");
    expect(plan.getFeature("F1")?.state).toBe("done"); // its only session merged
  });

  it("close_session errors on a session that isn't in review", async () => {
    seedFeatureSession();
    expect(await isError("close_session", { sessionId: "S1" })).toBe(true);
  });
});

describe("promote", () => {
  it("tier-promotes an escalated chunk and re-dispatches it on the strong tier", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    service.dispatchReady("S1");
    escalate("a");

    const body = await callText("promote", { chunkId: "a" });
    expect(body).toContain("Tier-promoted chunk a to strong");
    expect(dispatch.get("a-r2")?.tier).toBe("strong");
    expect(plan.getChunk("a")?.state).toBe("dispatched");
  });

  it("returns a tool error promoting a chunk that isn't escalated", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    expect(await isError("promote", { chunkId: "a" })).toBe(true);
  });
});

describe("redecompose", () => {
  const replacements = [
    { id: "a1", surface: "src/a1.ts", intent: "do a1", contract: "c", acceptance: "t" },
    { id: "a2", surface: "src/a2.ts", intent: "do a2", contract: "c", acceptance: "t" },
  ];

  it("retires an escalated chunk and adds replacements", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    service.dispatchReady("S1");
    escalate("a");

    const body = await callText("redecompose", { chunkId: "a", chunks: replacements, edges: [{ from: "a1", to: "a2" }] });
    expect(body).toContain("Re-decomposed chunk a (retired) into 2 chunk(s)");
    expect(plan.getChunk("a")?.state).toBe("superseded");
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "a1", "a2"]);
  });

  it("returns a tool error for a cyclic re-decomposition", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    service.dispatchReady("S1");
    escalate("a");

    const cyclic = { chunkId: "a", chunks: replacements, edges: [{ from: "a1", to: "a2" }, { from: "a2", to: "a1" }] };
    expect(await isError("redecompose", cyclic)).toBe(true);
    expect(plan.getChunk("a")?.state).toBe("escalated"); // unchanged
  });
});

describe("add + revise + prune before approval (ADR 0020 §5b)", () => {
  it("adds a chunk to an existing session, wired with an edge", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));

    const body = await callText("add_chunk", {
      sessionId: "S1",
      chunk: { id: "b", surface: "src/b.ts", intent: "do b", contract: "c", acceptance: "t" },
      edges: [{ from: "a", to: "b" }],
    });
    expect(body).toContain("Added chunk b to session S1");
    expect(plan.listChunks("S1").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("adds a session to a feature and an edge between two chunks (full symmetry)", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b"));

    const addedSession = await callText("add_session", { featureId: "F1", sessionId: "S2", locEstimate: 600 });
    expect(addedSession).toContain("Added session S2 to feature F1");
    expect(plan.listSessions("F1").map((s) => s.id)).toEqual(["S1", "S2"]);

    const addedEdge = await callText("add_edge", { from: "a", to: "b" });
    expect(addedEdge).toContain("Added edge a → b");
    expect(plan.listEdges("S1")).toEqual([{ from: "a", to: "b" }]);
  });

  it("returns a tool error adding a cross-session edge", async () => {
    seedFeatureSession();
    plan.createSession({ id: "S2", featureId: "F1" });
    plan.addChunk(chunk("a"));
    plan.addChunk(chunk("b", { sessionId: "S2" }));

    expect(await isError("add_edge", { from: "a", to: "b" })).toBe(true);
  });

  it("revises a chunk and prunes a session while the feature is planning", async () => {
    seedFeatureSession();
    plan.createSession({ id: "S2", featureId: "F1" });
    plan.addChunk(chunk("a"));

    const revised = await callText("revise_chunk", { chunkId: "a", contract: "export function a(n: number): void" });
    expect(revised).toContain("Revised chunk a");
    expect(plan.getChunk("a")?.contract).toBe("export function a(n: number): void");

    const removed = await callText("remove_session", { sessionId: "S2" });
    expect(removed).toContain("Removed session S2");
    expect(plan.getSession("S2")).toBeNull();
  });

  it("returns a tool error once the feature is approved (frozen)", async () => {
    seedFeatureSession();
    plan.addChunk(chunk("a"));
    plan.transitionFeature("F1", "ready"); // approved

    expect(await isError("revise_chunk", { chunkId: "a", contract: "x" })).toBe(true);
    expect(await isError("remove_chunk", { chunkId: "a" })).toBe(true);
  });
});

// The launch path is the real risk for an MCP server (a tool can unit-test green yet not
// appear over the actual stdio boot OpenCode uses). Spawn the real subprocess the way
// opencode.json does and confirm the tool list — pointing it at a temp db via SUBSTRATE_DB.
describe("stdio smoke-boot", () => {
  it("boots as a subprocess and lists the full toolset", async () => {
    const smokeDir = mkdtempSync(join(tmpdir(), "ah-mcp-stdio-"));
    const env: Record<string, string> = { SUBSTRATE_DB: join(smokeDir, "substrate.db") };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

    const transport = new StdioClientTransport({ command: "bun", args: ["run", "src/mcp/server.ts"], env });
    const smokeClient = new Client({ name: "smoke", version: "0.0.0" });
    try {
      await smokeClient.connect(transport);
      const { tools } = await smokeClient.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "add_chunk",
        "add_edge",
        "add_session",
        "address_review",
        "close_session",
        "decompose",
        "dispatch",
        "meta_decompose",
        "promote",
        "redecompose",
        "remove_chunk",
        "remove_edge",
        "remove_session",
        "revise_chunk",
        "status",
      ]);
    } finally {
      await smokeClient.close();
      rmSync(smokeDir, { recursive: true, force: true });
    }
  });
});
