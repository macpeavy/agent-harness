import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFailure, escalateOrFail } from "./escalation";
import { DispatchRepository, type CreateDispatch } from "../substrate/dispatch";

const SEED: CreateDispatch = { id: "d1", issueId: "I1", title: "t", branch: "b", spec: "s" };

let dir: string;
let repo: DispatchRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-escalation-"));
  repo = new DispatchRepository(join(dir, "dispatches.db"));
});

afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("classifyFailure (the ADR 0023 taxonomy in code)", () => {
  it("parks every recoverable mode with its reason; only substrate is terminal", () => {
    expect(classifyFailure({ kind: "no-op" })).toMatchObject({ terminal: false, reason: "no-op" });
    expect(classifyFailure({ kind: "error", message: "boom" })).toEqual({ terminal: false, reason: "error", message: "boom" });
    expect(classifyFailure({ kind: "timeout", message: "slow" })).toEqual({ terminal: false, reason: "attended", message: "slow" });
    expect(classifyFailure({ kind: "amend-cap" })).toMatchObject({ terminal: false, reason: "re-decompose" });
    expect(classifyFailure({ kind: "owner-note" })).toMatchObject({ terminal: false, reason: "attended" });
    expect(classifyFailure({ kind: "blocked", message: "bash: rm" })).toEqual({ terminal: false, reason: "attended", message: "bash: rm" });
    expect(classifyFailure({ kind: "substrate", message: "db gone" })).toEqual({ terminal: true, message: "db gone" });
  });

  it("every parked mode carries a message — escalation_reason is never null (ADR 0027)", () => {
    // The AGENT-55 blind-routing bug: `attended` with a null reason. The modes without a
    // caller-supplied message get a default that names the cause.
    expect(classifyFailure({ kind: "no-op" }).message).toContain("changed nothing");
    expect(classifyFailure({ kind: "amend-cap" }).message).toContain("amend cap");
    expect(classifyFailure({ kind: "owner-note" }).message).toContain("owner's review note");
  });
});

describe("escalateOrFail (the single write surface)", () => {
  function building(): void {
    repo.create(SEED);
    repo.transition("d1", "building");
  }

  it("parks a no-op build (escalated, reason no-op) — not terminal failed", () => {
    building();
    escalateOrFail(repo, "d1", { kind: "no-op" });
    expect(repo.get("d1")?.state).toBe("escalated");
    expect(repo.get("d1")?.escalated).toBe("no-op");
    expect(repo.get("d1")?.escalationReason).not.toBeNull(); // the default message is recorded
  });

  it("parks a failed owner-note amend with the recorded reason (ADR 0027)", () => {
    repo.create(SEED);
    repo.transition("d1", "building");
    repo.transition("d1", "review");
    repo.transition("d1", "done");
    repo.reopenForReview("d1", "the owner's notes");
    escalateOrFail(repo, "d1", { kind: "owner-note" });

    const d = repo.get("d1");
    expect(d?.state).toBe("escalated");
    expect(d?.escalated).toBe("attended");
    expect(d?.escalationReason).toContain("owner's review note");
    expect(d?.pendingFindings).toBe("the owner's notes"); // kept for the amend-resume promote
  });

  it("parks a leg error with its message recorded", () => {
    building();
    escalateOrFail(repo, "d1", { kind: "error", message: "install failed" });
    const d = repo.get("d1");
    expect(d?.state).toBe("escalated");
    expect(d?.escalated).toBe("error");
    expect(d?.escalationReason).toBe("install failed");
  });

  it("terminal-fails only an unrecoverable substrate condition", () => {
    building();
    escalateOrFail(repo, "d1", { kind: "substrate", message: "repo gone" });
    expect(repo.get("d1")?.state).toBe("failed");
  });
});

describe("the daemon routes ALL failure/escalation through the central surface", () => {
  it("daemon.ts writes no ad-hoc escalate()/transition(failed) — they live only in escalation.ts", () => {
    const src = readFileSync("src/dispatch/daemon.ts", "utf8");
    expect(src).not.toContain(".escalate("); // no inline escalate; goes through escalateOrFail
    expect(src).not.toMatch(/transition\([^)]*"failed"/); // no ad-hoc terminal fail
  });
});
