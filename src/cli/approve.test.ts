import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveFeature } from "./approve";
import { PlanRepository } from "../substrate/plan";

let dir: string;
let plan: PlanRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-approve-"));
  plan = new PlanRepository(join(dir, "substrate.db"));
});

afterEach(() => {
  plan.close();
  rmSync(dir, { recursive: true, force: true });
});

const FEATURE = { id: "F1", title: "A feature", description: "the owner's intent" };

describe("approveFeature", () => {
  it("moves a planning feature to ready", () => {
    plan.createFeature(FEATURE);
    approveFeature(plan, "F1");
    expect(plan.getFeature("F1")?.state).toBe("ready");
  });

  it("throws for an unknown feature", () => {
    expect(() => approveFeature(plan, "ghost")).toThrow("no feature ghost");
  });

  it("refuses to re-approve a feature that has left planning", () => {
    plan.createFeature(FEATURE);
    approveFeature(plan, "F1");
    expect(() => approveFeature(plan, "F1")).toThrow("not awaiting approval (state: ready)");
  });
});
