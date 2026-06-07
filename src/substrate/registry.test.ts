import { describe, expect, it, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { DispatchRegistry, type DispatchRecord } from "./registry";

const TEST_DB = "/tmp/reg-test-dispatches.db";

function fresh(): DispatchRegistry {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new DispatchRegistry(TEST_DB);
}

afterEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

const sample = { id: "d1", issue_id: "iss-1", title: "Test issue", branch: "feat/test" };

describe("DispatchRegistry", () => {
  it("creates and retrieves a dispatch", () => {
    const reg = fresh();
    reg.create(sample);
    const got = reg.get("d1");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("d1");
    expect(got!.issue_id).toBe("iss-1");
    expect(got!.title).toBe("Test issue");
    expect(got!.branch).toBe("feat/test");
    expect(got!.state).toBe("queued");
    expect(got!.build_session_id).toBeNull();
    expect(got!.review_session_id).toBeNull();
    expect(got!.pr_url).toBeNull();
    expect(got!.cost_usd).toBeNull();
    expect(got!.created_at).toBeGreaterThan(0);
    expect(got!.updated_at).toBe(got!.created_at);
  });

  it("returns null for missing id", () => {
    const reg = fresh();
    expect(reg.get("nope")).toBeNull();
  });

  it("lists dispatches newest first", () => {
    const reg = fresh();
    reg.create({ id: "a", issue_id: "i1", title: "A", branch: "b1" });
    Bun.sleepSync(5);
    reg.create({ id: "b", issue_id: "i2", title: "B", branch: "b2" });
    const all = reg.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe("b");
    expect(all[1]!.id).toBe("a");
  });

  it("lists with state filter", () => {
    const reg = fresh();
    reg.create({ id: "a", issue_id: "i1", title: "A", branch: "b1" });
    reg.create({ id: "b", issue_id: "i2", title: "B", branch: "b2" });
    reg.transition("b", "building");
    const queued = reg.list({ state: "queued" });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe("a");
    const building = reg.list({ state: "building" });
    expect(building).toHaveLength(1);
    expect(building[0]!.id).toBe("b");
  });

  it("follows the happy path: queued -> building -> review -> done", () => {
    const reg = fresh();
    reg.create(sample);
    expect(reg.get("d1")!.state).toBe("queued");
    reg.transition("d1", "building");
    expect(reg.get("d1")!.state).toBe("building");
    reg.transition("d1", "review");
    expect(reg.get("d1")!.state).toBe("review");
    reg.transition("d1", "done");
    expect(reg.get("d1")!.state).toBe("done");
  });

  it("allows transition to failed from any non-terminal state", () => {
    const reg = fresh();
    reg.create(sample);
    reg.transition("d1", "failed");
    expect(reg.get("d1")!.state).toBe("failed");
  });

  it("throws on illegal transition", () => {
    const reg = fresh();
    reg.create(sample);
    expect(() => reg.transition("d1", "review")).toThrow("Illegal transition");
    expect(reg.get("d1")!.state).toBe("queued"); // unchanged
  });

  it("throws when transitioning from a terminal state", () => {
    const reg = fresh();
    reg.create(sample);
    reg.transition("d1", "building");
    reg.transition("d1", "review");
    reg.transition("d1", "done");
    expect(() => reg.transition("d1", "failed")).toThrow("Illegal transition");
    expect(reg.get("d1")!.state).toBe("done");
  });

  it("throws on transition for unknown id", () => {
    const reg = fresh();
    expect(() => reg.transition("nope", "building")).toThrow("Dispatch not found");
  });

  it("sets build and review session ids", () => {
    const reg = fresh();
    reg.create(sample);
    reg.setSessions("d1", { buildSessionId: "sess-b" });
    expect(reg.get("d1")!.build_session_id).toBe("sess-b");
    expect(reg.get("d1")!.review_session_id).toBeNull();
    reg.setSessions("d1", { reviewSessionId: "sess-r" });
    expect(reg.get("d1")!.build_session_id).toBe("sess-b");
    expect(reg.get("d1")!.review_session_id).toBe("sess-r");
  });

  it("sets pr url", () => {
    const reg = fresh();
    reg.create(sample);
    reg.setPr("d1", "https://github.com/example/pr/1");
    expect(reg.get("d1")!.pr_url).toBe("https://github.com/example/pr/1");
  });

  it("sets cost", () => {
    const reg = fresh();
    reg.create(sample);
    reg.setCost("d1", 1.23);
    expect(reg.get("d1")!.cost_usd).toBe(1.23);
  });

  it("resumeIncomplete returns only non-terminal dispatches", () => {
    const reg = fresh();
    reg.create({ id: "a", issue_id: "i1", title: "A", branch: "b1" });
    reg.create({ id: "b", issue_id: "i2", title: "B", branch: "b2" });
    reg.create({ id: "c", issue_id: "i3", title: "C", branch: "b3" });
    reg.transition("a", "building");
    reg.transition("b", "building");
    reg.transition("b", "review");
    reg.transition("c", "building");
    reg.transition("c", "review");
    reg.transition("c", "done");
    const incomplete = reg.resumeIncomplete();
    const ids = incomplete.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});