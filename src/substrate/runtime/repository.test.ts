import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRepository } from "./index";

let dir: string;
let runtime: RuntimeRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-runtime-"));
  runtime = new RuntimeRepository(join(dir, "substrate.db"));
});

afterEach(() => {
  runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("chief registration (ADR 0024)", () => {
  it("getChief on an empty db returns null", () => {
    expect(runtime.getChief()).toBeNull();
  });

  it("registers the chief and reads it back", () => {
    runtime.registerChief({ sessionId: "ses_1", baseUrl: "http://localhost:4096" });
    const reg = runtime.getChief();
    expect(reg?.sessionId).toBe("ses_1");
    expect(reg?.baseUrl).toBe("http://localhost:4096");
    expect(reg?.registeredAt).toBeGreaterThan(0);
  });

  it("re-registering replaces the prior registration (one chief at a time)", () => {
    runtime.registerChief({ sessionId: "ses_old", baseUrl: "http://localhost:4096" });
    runtime.registerChief({ sessionId: "ses_new", baseUrl: "http://localhost:5000" });
    const reg = runtime.getChief();
    expect(reg?.sessionId).toBe("ses_new");
    expect(reg?.baseUrl).toBe("http://localhost:5000");
  });

  it("clearChief removes the registration when the session id still matches", () => {
    runtime.registerChief({ sessionId: "ses_1", baseUrl: "http://localhost:4096" });
    runtime.clearChief("ses_1");
    expect(runtime.getChief()).toBeNull();
  });

  it("clearChief is a no-op when a newer chief has replaced the row (the slow-exit guard)", () => {
    runtime.registerChief({ sessionId: "ses_old", baseUrl: "http://localhost:4096" });
    runtime.registerChief({ sessionId: "ses_new", baseUrl: "http://localhost:4096" });
    runtime.clearChief("ses_old"); // the old launcher exits late
    expect(runtime.getChief()?.sessionId).toBe("ses_new"); // the new registration survives
  });
});

describe("driver heartbeats (AGENT-44)", () => {
  it("listHeartbeats on an empty db returns []", () => {
    expect(runtime.listHeartbeats()).toEqual([]);
  });

  it("beat inserts the row, then refreshes lastSeen on the same process", async () => {
    runtime.beat("daemon", 100, 10_000, 50_000);
    const first = runtime.listHeartbeats()[0];
    expect(first?.driver).toBe("daemon");
    expect(first?.pid).toBe(100);
    expect(first?.startedAt).toBe(50_000);

    await Bun.sleep(2); // lastSeen is Date.now() — let it tick
    runtime.beat("daemon", 100, 10_000, 50_000);
    const second = runtime.listHeartbeats()[0];
    expect(second?.lastSeen).toBeGreaterThan(first?.lastSeen ?? 0);
    expect(second?.startedAt).toBe(50_000); // stable across the process's beats
  });

  it("a restarted driver (new pid) overwrites pid and startedAt", () => {
    runtime.beat("daemon", 100, 10_000, 50_000);
    runtime.beat("daemon", 200, 10_000, 90_000); // the restart
    const rows = runtime.listHeartbeats();
    expect(rows.length).toBe(1); // still one row per driver
    expect(rows[0]?.pid).toBe(200);
    expect(rows[0]?.startedAt).toBe(90_000);
  });

  it("lists drivers in stable name order", () => {
    runtime.beat("session-loop", 2, 10_000, 1);
    runtime.beat("daemon", 1, 10_000, 1);
    expect(runtime.listHeartbeats().map((r) => r.driver)).toEqual(["daemon", "session-loop"]);
  });
});
