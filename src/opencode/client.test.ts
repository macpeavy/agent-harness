import { describe, expect, it } from "bun:test";
import { activitySignature, timeoutKind } from "./client";

describe("activitySignature (idle activity proxy, AGENT-38)", () => {
  it("grows as messages and text accrue; is stable when nothing changes", () => {
    const a = [{ parts: [{ type: "text", text: "hi" }] }];
    const b = [{ parts: [{ type: "text", text: "hi there" }] }]; // same message, longer part
    const c = [{ parts: [{ type: "text", text: "hi there" }] }, { parts: [{ type: "text", text: "x" }] }]; // new message
    expect(activitySignature(a)).toBe(activitySignature(a)); // stable
    expect(activitySignature(b)).toBeGreaterThan(activitySignature(a)); // part grew
    expect(activitySignature(c)).toBeGreaterThan(activitySignature(b)); // message added
    expect(activitySignature([])).toBe(0);
  });

  // The reviewer bug: its work is tool calls + results (no text), which the text-only signature
  // missed — so a working reviewer looked idle and got killed. Tool activity MUST register.
  it("registers tool-call and tool-result activity (not just text)", () => {
    const justTask = [{ parts: [{ type: "text", text: "review this" }] }];
    // The reviewer invokes a tool (a new tool part, no text) — that is progress, not idle.
    const toolCalled = [
      { parts: [{ type: "text", text: "review this" }, { type: "tool", state: "running", tool: "bash" }] },
    ];
    // The tool returns a large diff — the part transitions and fills with output: more progress.
    const toolReturned = [
      {
        parts: [
          { type: "text", text: "review this" },
          { type: "tool", state: "completed", tool: "bash", output: "diff --git ...".repeat(20) },
        ],
      },
    ];
    expect(activitySignature(toolCalled)).toBeGreaterThan(activitySignature(justTask)); // tool call counts
    expect(activitySignature(toolReturned)).toBeGreaterThan(activitySignature(toolCalled)); // result counts
  });

  it("a new step boundary (no text) still counts as activity", () => {
    const before = [{ parts: [{ type: "step-start" }] }];
    const after = [{ parts: [{ type: "step-start" }, { type: "step-finish" }] }];
    expect(activitySignature(after)).toBeGreaterThan(activitySignature(before));
  });
});

describe("timeoutKind (idle vs absolute, AGENT-38)", () => {
  const idleMs = 120_000;
  const absoluteMs = 1_800_000;

  it("keeps waiting while inside both windows", () => {
    // 60s in, last activity 10s ago → neither tripped.
    expect(timeoutKind(60_000, 0, 50_000, idleMs, absoluteMs)).toBeNull();
  });

  it("aborts idle when there's no activity for the idle window", () => {
    // 200s in, last activity at 0 → 200s idle > 120s.
    expect(timeoutKind(200_000, 0, 0, idleMs, absoluteMs)).toBe("idle");
  });

  it("does NOT kill a slow-but-progressing session past the OLD 600s cap", () => {
    // 700s in (past the old 10-min wall-clock), but activity 5s ago → still working, keep waiting.
    expect(timeoutKind(700_000, 0, 695_000, idleMs, absoluteMs)).toBeNull();
  });

  it("the absolute backstop still kills a runaway session that keeps producing", () => {
    // 1.9M ms in, activity 1s ago (still noisy) → absolute wins over idle.
    expect(timeoutKind(1_900_000, 0, 1_899_000, idleMs, absoluteMs)).toBe("absolute");
  });
});
