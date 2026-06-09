import { describe, expect, it } from "bun:test";
import { driveOrAbort, type SessionKiller } from "./agent-runner";
import { AgentTimeoutError } from "./client";

// A fake session killer that records deleteSession calls (Part 4 — orphan teardown on timeout).
function killer(opts: { deleteThrows?: boolean } = {}): SessionKiller & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteSession(id) {
      deleted.push(id);
      if (opts.deleteThrows) throw new Error("delete failed");
    },
  };
}

describe("driveOrAbort (kill the OpenCode session on timeout, AGENT-38 part 4)", () => {
  it("tears down the session when the drive times out, then rethrows the timeout", async () => {
    const k = killer();
    const err = new AgentTimeoutError("ses_1", 120_000, "idle");
    await expect(
      driveOrAbort(k, "ses_1", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(k.deleted).toEqual(["ses_1"]); // no orphan left generating
  });

  it("does NOT delete the session on success", async () => {
    const k = killer();
    const out = await driveOrAbort(k, "ses_1", async () => "done");
    expect(out).toBe("done");
    expect(k.deleted).toEqual([]);
  });

  it("does not delete on a non-timeout error (leaves it for the normal failure path)", async () => {
    const k = killer();
    await expect(
      driveOrAbort(k, "ses_1", async () => {
        throw new Error("build boom");
      }),
    ).rejects.toThrow("build boom");
    expect(k.deleted).toEqual([]);
  });

  it("a teardown failure doesn't mask the timeout", async () => {
    const k = killer({ deleteThrows: true });
    await expect(
      driveOrAbort(k, "ses_1", async () => {
        throw new AgentTimeoutError("ses_1", 120_000, "idle");
      }),
    ).rejects.toBeInstanceOf(AgentTimeoutError); // the timeout still propagates
    expect(k.deleted).toEqual(["ses_1"]); // it tried
  });
});
