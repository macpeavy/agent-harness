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
