import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRepository } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import { assembleHistory } from "./history-assemble";
import { renderHistory } from "./history-render";

let dir: string;
let plan: PlanRepository;
let dispatch: DispatchRepository;
let service: PlanDispatchService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-history-"));
  const dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
  service = new PlanDispatchService(plan, dispatch);
});

afterEach(() => {
  plan.close();
  dispatch.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("history CLI", () => {
  it("loads feature graph, assembles history, and renders it", () => {
    const featureId = "feat-1";
    const sessionId = "sess-1";
    const chunkId = "chunk-1";

    service.metaDecompose({
      feature: { id: featureId, title: "Test Feature", description: "A test" },
      sessions: [{ id: sessionId }],
    });

    service.decompose({
      sessionId,
      chunks: [
        {
          id: chunkId,
          surface: "src/test.ts",
          intent: "test intent",
          contract: "export function test(): void",
          acceptance: "test passes",
        },
      ],
      edges: [],
    });

    const graph = plan.loadFeatureGraph(featureId);
    expect(graph).not.toBeNull();
    expect(graph!.feature.id).toBe(featureId);
    expect(graph!.sessions.length).toBe(1);
    expect(graph!.sessions[0]!.chunks.length).toBe(1);

    const history = assembleHistory(graph!);
    expect(history.feature.id).toBe(featureId);
    expect(history.sessions.length).toBe(1);
    expect(history.chiefCostNote).toBe("dispatch-legs only");

    const output = renderHistory(history);
    expect(output).toContain(featureId);
    expect(output).toContain("dispatch-legs only");
  });

  it("handles missing feature (returns null from loadFeatureGraph)", () => {
    const graph = plan.loadFeatureGraph("nonexistent-feature");
    expect(graph).toBeNull();
  });

  it("renders history with one session and two chunks with edges", () => {
    const featureId = "feat-2";
    const sessionId = "sess-2";
    const chunkId1 = "chunk-2a";
    const chunkId2 = "chunk-2b";

    service.metaDecompose({
      feature: { id: featureId, title: "Feature Two", description: "Another test" },
      sessions: [{ id: sessionId, locEstimate: 250 }],
    });

    service.decompose({
      sessionId,
      chunks: [
        {
          id: chunkId1,
          surface: "src/important.ts",
          intent: "important work",
          contract: "export interface Important {}",
          acceptance: "all tests pass",
        },
        {
          id: chunkId2,
          surface: "src/dependent.ts",
          intent: "depends on chunk-2a",
          contract: "export function dependent(): void",
          acceptance: "builds with chunk-2a",
        },
      ],
      edges: [{ from: chunkId1, to: chunkId2 }],
    });

    const graph = plan.loadFeatureGraph(featureId);
    expect(graph).not.toBeNull();
    expect(graph!.sessions[0]!.chunks.length).toBe(2);

    const history = assembleHistory(graph!);
    expect(history.feature.id).toBe(featureId);
    expect(history.sessions.length).toBe(1);
    expect(history.sessions[0]!.chunks.length).toBe(2);
    expect(history.sessions[0]!.chunks[1]!.dependsOn).toEqual([chunkId1]);

    const output = renderHistory(history);
    expect(output).toContain(featureId);
    expect(output).toContain("dispatch-legs only");
    expect(output).toContain("depends on");
  });
});
