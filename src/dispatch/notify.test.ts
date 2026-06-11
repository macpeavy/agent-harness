import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotifyPass, chiefWakePrompt, type ChiefDirectory, type Notifier, type ReviewReadyNotice } from "./notify";
import { PlanDispatchService } from "./plan-dispatch";
import { PlanRepository, type CreateChunk } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";
import type { ChiefRegistration } from "../substrate/runtime";

let dir: string;
let plan: PlanRepository;
let dispatch: DispatchRepository;
let service: PlanDispatchService;

// Fakes: the chief directory (a registration or none), the wake (records calls), the
// owner notifier (records notices) — so the pass is exercised over REAL repositories
// (the stamp/clear behavior is the contract under test) without a live OpenCode server.
let registration: ChiefRegistration | null;
let wakes: { baseUrl: string; sessionId: string; prompt: string }[];
let notices: ReviewReadyNotice[];

const chiefs: ChiefDirectory = { getChief: () => registration };
const notifier: Notifier = { reviewReady: (n) => void notices.push(n) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ah-notify-"));
  const dbPath = join(dir, "substrate.db");
  plan = new PlanRepository(dbPath);
  dispatch = new DispatchRepository(dbPath);
  service = new PlanDispatchService(plan, dispatch);
  registration = { id: "chief", sessionId: "ses_chief", baseUrl: "http://localhost:4096", registeredAt: 1 };
  wakes = [];
  notices = [];
});

afterEach(() => {
  plan.close();
  dispatch.close();
  rmSync(dir, { recursive: true, force: true });
});

const FEATURE = { id: "F1", title: "A feature", description: "the owner's intent" };

function chunk(id: string): CreateChunk {
  return { id, sessionId: "S1", surface: `src/${id}.ts`, intent: `do ${id}`, contract: "c", acceptance: "t" };
}

function pass(wake = async (t: { baseUrl: string; sessionId: string }, prompt: string) => void wakes.push({ ...t, prompt })) {
  return new NotifyPass(plan, service, chiefs, notifier, wake);
}

// Seed F1/S1 with one chunk, approved and dispatched (S1 → building).
function seedDispatched(): void {
  plan.createFeature(FEATURE);
  plan.createSession({ id: "S1", featureId: "F1" });
  plan.addChunk(chunk("a"));
  service.dispatchReady("S1");
}

// Park the chunk's dispatch and flow it back: S1 → needs-attention.
function parkChunk(id = "a"): void {
  dispatch.transition(id, "building");
  dispatch.escalate(id, "no-op", "builder changed nothing");
  service.recordOutcomes("S1");
}

// Land the chunk and flow it back: S1 → review.
function landChunk(id = "a"): void {
  dispatch.transition(id, "building");
  dispatch.transition(id, "review");
  dispatch.transition(id, "done");
  service.recordOutcomes("S1");
}

describe("NotifyPass — needs-attention wakes the chief (ADR 0024)", () => {
  it("fires exactly one wake per transition, not per tick, with a self-contained payload", async () => {
    seedDispatched();
    parkChunk();

    expect(await pass().runOnce()).toBe(1);
    expect(wakes.length).toBe(1);
    expect(wakes[0]?.baseUrl).toBe("http://localhost:4096");
    expect(wakes[0]?.sessionId).toBe("ses_chief"); // the CHIEF's session, not the plan session
    // The payload carries enough to act without a status round-trip.
    expect(wakes[0]?.prompt).toContain("S1");
    expect(wakes[0]?.prompt).toContain("A feature");
    expect(wakes[0]?.prompt).toContain('"chunkId": "a"');
    expect(wakes[0]?.prompt).toContain("builder changed nothing");
    expect(wakes[0]?.prompt).toContain("redecompose / promote / address");
    expect(notices).toEqual([]); // the owner channel stays out of chief work

    expect(await pass().runOnce()).toBe(0); // stamped — a later tick fires nothing
    expect(wakes.length).toBe(1);
  });

  it("a re-park re-signals: routing clears the stamp, the next park fires again", async () => {
    seedDispatched();
    parkChunk();
    const p = pass();
    await p.runOnce();
    expect(wakes.length).toBe(1);

    service.promote("a"); // the chief routes it (escalated → dispatched, fresh dispatch a-r2)
    service.recordOutcomes("S1"); // needs-attention → building (clears the stamp)

    dispatch.transition("a-r2", "building");
    dispatch.escalate("a-r2", "re-decompose");
    service.recordOutcomes("S1"); // parks again

    expect(await p.runOnce()).toBe(1); // re-signaled
    expect(wakes.length).toBe(2);
  });

  it("degrades cleanly with no chief registered: no wake, no stamp, retried when one appears", async () => {
    seedDispatched();
    parkChunk();
    registration = null;

    const p = pass();
    expect(await p.runOnce()).toBe(0);
    expect(wakes).toEqual([]);
    expect(plan.getSession("S1")?.signaledAt).toBeNull(); // still pending — pull remains the floor

    registration = { id: "chief", sessionId: "ses_chief", baseUrl: "http://localhost:4096", registeredAt: 2 };
    expect(await p.runOnce()).toBe(1); // a later chief launch picks it up
    expect(wakes.length).toBe(1);
  });

  it("swallows a failed wake (stale registration) and leaves the signal pending", async () => {
    seedDispatched();
    parkChunk();
    const p = pass(async () => {
      throw new Error("connection refused");
    });

    expect(await p.runOnce()).toBe(0); // must not throw
    expect(plan.getSession("S1")?.signaledAt).toBeNull(); // un-stamped, retried next tick
  });

  it("a budget-parked session wakes the chief with the budget marker, not parked chunks", async () => {
    seedDispatched();
    plan.setBudget("F1", 1.0);
    service.parkOverBudget("F1", 1.3); // → needs-attention with budgetExceededUsd set

    expect(await pass().runOnce()).toBe(1);
    expect(wakes[0]?.prompt).toContain("budget-parked");
    expect(wakes[0]?.prompt).toContain('"budgetExceededUsd": 1.3');
  });
});

describe("NotifyPass — review notifies the owner and FYIs the chief (ADR 0024 + 0028)", () => {
  it("fires the Notifier once with the PR linkage and sends the chief the review-ready FYI", async () => {
    seedDispatched();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 42, prUrl: "http://pr/42" });
    landChunk();

    expect(await pass().runOnce()).toBe(1);
    expect(notices.length).toBe(1);
    expect(notices[0]?.prNumber).toBe(42);
    expect(notices[0]?.prUrl).toBe("http://pr/42");
    expect(notices[0]?.featureTitle).toBe("A feature");
    expect(notices[0]?.chunkCount).toBe(1);
    // The chief FYI (ADR 0028): built + with the owner, nothing to route or close.
    expect(wakes.length).toBe(1);
    expect(wakes[0]?.prompt).toContain("awaiting the owner's review");
    expect(wakes[0]?.prompt).toContain("http://pr/42");
    expect(wakes[0]?.prompt).toContain("do NOT call close_session");

    expect(await pass().runOnce()).toBe(0); // once per transition — owner and FYI both
    expect(notices.length).toBe(1);
    expect(wakes.length).toBe(1);
  });

  it("with no chief registered, the owner is still notified and the signal stamps (FYI is at-most-once)", async () => {
    seedDispatched();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 42, prUrl: "http://pr/42" });
    landChunk();
    registration = null;

    expect(await pass().runOnce()).toBe(1); // the owner signal fires and stamps
    expect(notices.length).toBe(1);
    expect(wakes).toEqual([]);
    expect(plan.getSession("S1")?.signaledAt).not.toBeNull(); // no re-ring of the owner's bell

    registration = { id: "chief", sessionId: "ses_chief", baseUrl: "http://localhost:4096", registeredAt: 2 };
    expect(await pass().runOnce()).toBe(0); // the missed FYI does NOT re-fire — status covers it
    expect(wakes).toEqual([]);
  });

  it("a failed chief FYI never blocks the owner's stamp", async () => {
    seedDispatched();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 42, prUrl: "http://pr/42" });
    landChunk();
    const p = pass(async () => {
      throw new Error("connection refused"); // every chief wake fails
    });

    expect(await p.runOnce()).toBe(1); // owner notified, stamped
    expect(notices.length).toBe(1);
    expect(plan.getSession("S1")?.signaledAt).not.toBeNull();
  });

  it("a throwing Notifier is contained and the signal stays pending (at-least-once)", async () => {
    seedDispatched();
    landChunk();
    const throwing = new NotifyPass(plan, service, chiefs, {
      reviewReady: () => {
        throw new Error("notifier down");
      },
    });

    expect(await throwing.runOnce()).toBe(0); // must not throw
    expect(plan.getSession("S1")?.signaledAt).toBeNull(); // retried next tick
    expect(wakes).toEqual([]); // no FYI either — it follows a successful owner notify
  });
});

describe("NotifyPass — an auto-closed session tells the chief (AGENT-45)", () => {
  it("pushes the chief once with the completion payload after a substrate-detected merge", async () => {
    seedDispatched();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 42, prUrl: "http://pr/42" });
    landChunk();
    plan.stampSignaled("S1"); // the review→owner signal already fired

    service.closeSession("S1"); // the loop's auto-close path: notifyChief defaults true

    expect(await pass().runOnce()).toBe(1);
    expect(wakes.length).toBe(1);
    expect(wakes[0]?.prompt).toContain("http://pr/42");
    expect(wakes[0]?.prompt).toContain("merged on GitHub");
    expect(wakes[0]?.prompt).toContain("do NOT call close_session");
    expect(wakes[0]?.prompt).toContain('"featureState": "done"'); // last session → feature completed
    expect(notices).toEqual([]); // completion is chief-picture work, not an owner ask

    expect(await pass().runOnce()).toBe(0); // stamped — once per transition
    expect(wakes.length).toBe(1);
  });

  it("a manual close_session suppresses the push — the chief already knows", async () => {
    seedDispatched();
    landChunk();
    plan.stampSignaled("S1");

    service.closeSession("S1", { notifyChief: false }); // the MCP tool's path

    expect(await pass().runOnce()).toBe(0);
    expect(wakes).toEqual([]);
    expect(plan.getSession("S1")?.signaledAt).not.toBeNull(); // stamped as already known
  });

  it("degrades cleanly with no chief: the done signal stays pending for a later launch", async () => {
    seedDispatched();
    landChunk();
    plan.stampSignaled("S1");
    service.closeSession("S1");
    registration = null;

    const p = pass();
    expect(await p.runOnce()).toBe(0);
    expect(plan.getSession("S1")?.signaledAt).toBeNull();

    registration = { id: "chief", sessionId: "ses_chief", baseUrl: "http://localhost:4096", registeredAt: 2 };
    expect(await p.runOnce()).toBe(1); // the next chief hears about it
  });
});

describe("NotifyPass — a CI failure on a built session wakes the chief (the CI leg)", () => {
  // S1 in review with a PR and a recorded CI failure on sha-1.
  function seedCiFailure(): void {
    seedDispatched();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 42, prUrl: "http://pr/42" });
    landChunk();
    plan.stampSignaled("S1"); // the review→owner signal already fired
    plan.setCiFailure("S1", "sha-1", ["typecheck", "test"]);
  }

  it("wakes the chief once per failing head with the checks + amend_chunk routing", async () => {
    seedCiFailure();

    expect(await pass().runOnce()).toBe(1);
    expect(wakes.length).toBe(1);
    expect(wakes[0]?.prompt).toContain("CI failed");
    expect(wakes[0]?.prompt).toContain("typecheck, test");
    expect(wakes[0]?.prompt).toContain("amend_chunk");
    expect(wakes[0]?.prompt).toContain('"surface": "src/a.ts"'); // the chunk map rides along
    expect(notices).toEqual([]); // a CI failure is chief work, not an owner ask

    expect(await pass().runOnce()).toBe(0); // stamped for sha-1 — once per head
    expect(wakes.length).toBe(1);
  });

  it("a re-push that fails again (new head) re-signals", async () => {
    seedCiFailure();
    const p = pass();
    await p.runOnce();
    expect(wakes.length).toBe(1);

    plan.setCiFailure("S1", "sha-2", ["test"]); // the probe recorded a new failing head
    expect(await p.runOnce()).toBe(1);
    expect(wakes.length).toBe(2);
    expect(wakes[1]?.prompt).toContain("sha-2");
  });

  it("degrades cleanly with no chief: the failure stays pending for a later launch", async () => {
    seedCiFailure();
    registration = null;

    const p = pass();
    expect(await p.runOnce()).toBe(0);
    expect(plan.getSession("S1")?.ciSignaledSha).toBeNull(); // un-stamped, still pending

    registration = { id: "chief", sessionId: "ses_chief", baseUrl: "http://localhost:4096", registeredAt: 2 };
    expect(await p.runOnce()).toBe(1);
  });

  it("a failed wake is swallowed and the signal stays pending", async () => {
    seedCiFailure();
    const p = pass(async () => {
      throw new Error("connection refused");
    });
    expect(await p.runOnce()).toBe(0); // must not throw
    expect(plan.getSession("S1")?.ciSignaledSha).toBeNull();
  });
});

describe("NotifyPass — an owner response on an in-review PR wakes the chief (AGENT-54)", () => {
  // S1 in review with a PR and a recorded owner response at t=1000.
  function seedOwnerResponse(): void {
    seedDispatched();
    plan.linkSessionPr("S1", { branch: "session-main-S1", prNumber: 42, prUrl: "http://pr/42" });
    landChunk();
    plan.stampSignaled("S1"); // the review→owner signal already fired
    plan.setOwnerResponse("S1", 1_000);
  }

  it("wakes the chief once per response wave with the address_review routing", async () => {
    seedOwnerResponse();

    expect(await pass().runOnce()).toBe(1);
    expect(wakes.length).toBe(1);
    expect(wakes[0]?.prompt).toContain("owner responded");
    expect(wakes[0]?.prompt).toContain('address_review("S1")');
    expect(notices).toEqual([]); // routing the review is chief work, not an owner ask

    expect(await pass().runOnce()).toBe(0); // stamped for this wave — exactly once
    expect(wakes.length).toBe(1);
  });

  it("a NEWER response wave re-signals (the owner replied again after an amend)", async () => {
    seedOwnerResponse();
    const p = pass();
    await p.runOnce();
    expect(wakes.length).toBe(1);

    plan.setOwnerResponse("S1", 2_000); // the probe recorded a newer wave
    expect(await p.runOnce()).toBe(1);
    expect(wakes.length).toBe(2);
  });

  it("degrades cleanly with no chief: the response stays pending for a later launch", async () => {
    seedOwnerResponse();
    registration = null;

    const p = pass();
    expect(await p.runOnce()).toBe(0);
    expect(plan.getSession("S1")?.ownerResponseSignaledAt).toBeNull(); // un-stamped, still pending

    registration = { id: "chief", sessionId: "ses_chief", baseUrl: "http://localhost:4096", registeredAt: 2 };
    expect(await p.runOnce()).toBe(1);
  });

  it("a failed wake is swallowed and the signal stays pending", async () => {
    seedOwnerResponse();
    const p = pass(async () => {
      throw new Error("connection refused");
    });
    expect(await p.runOnce()).toBe(0); // must not throw
    expect(plan.getSession("S1")?.ownerResponseSignaledAt).toBeNull();
  });
});

describe("chiefWakePrompt", () => {
  it("renders the routing verbs and the JSON payload", () => {
    const prompt = chiefWakePrompt({
      sessionId: "S1",
      featureId: "F1",
      featureTitle: "T",
      parked: [{ chunkId: "a", surface: "src/a.ts", reason: "timeout" }],
      budgetExceededUsd: null,
      verbs: ["redecompose", "promote", "address"],
    });
    expect(prompt).toContain("needs-attention");
    expect(prompt).toContain('"surface": "src/a.ts"');
    expect(prompt).toContain("redecompose / promote / address");
  });
});
