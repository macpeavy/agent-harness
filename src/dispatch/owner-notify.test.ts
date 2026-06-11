import { describe, expect, it } from "bun:test";
import {
  CompositeNotifier,
  NtfyNotifier,
  TmuxNotifier,
  ownerNotifier,
  reviewReadyMessage,
} from "./owner-notify";
import type { Notifier, ReviewReadyNotice } from "./notify";

const NOTICE: ReviewReadyNotice = {
  sessionId: "S1",
  featureId: "F1",
  featureTitle: "A feature",
  prNumber: 151,
  prUrl: "http://pr/151",
  chunkCount: 1,
  costUsd: 0.0521,
};

describe("reviewReadyMessage", () => {
  it("renders the title, cost, and PR link in one line", () => {
    const msg = reviewReadyMessage(NOTICE);
    expect(msg).toContain('"A feature"');
    expect(msg).toContain("$0.05");
    expect(msg).toContain("http://pr/151");
  });

  it("falls back to the PR number, then to 'no PR linked'", () => {
    expect(reviewReadyMessage({ ...NOTICE, prUrl: null })).toContain("PR #151");
    expect(reviewReadyMessage({ ...NOTICE, prUrl: null, prNumber: null })).toContain("no PR linked");
  });
});

describe("TmuxNotifier", () => {
  it("sends the rendered message through the display runner", async () => {
    const shown: string[] = [];
    await new TmuxNotifier(async (m) => void shown.push(m)).reviewReady(NOTICE);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("review ready");
  });
});

describe("NtfyNotifier", () => {
  it("POSTs the message to server/topic with the push headers", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const n = new NtfyNotifier("fleet", "https://ntfy.example.com", async (url, init) => {
      calls.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 200 };
    });
    await n.reviewReady(NOTICE);

    expect(calls[0]?.url).toBe("https://ntfy.example.com/fleet");
    expect(calls[0]?.body).toContain("review ready");
    expect(calls[0]?.headers["Title"]).toContain("review");
  });

  it("throws on a non-2xx response, naming the URL and status", async () => {
    const n = new NtfyNotifier("fleet", "https://ntfy.sh", async () => ({ ok: false, status: 502 }));
    expect(n.reviewReady(NOTICE)).rejects.toThrow("ntfy POST https://ntfy.sh/fleet → 502");
  });
});

describe("CompositeNotifier", () => {
  const ok = (log: string[], name: string): Notifier => ({ reviewReady: () => void log.push(name) });
  const boom = (name: string): Notifier => ({
    reviewReady: () => {
      throw new Error(`${name} down`);
    },
  });

  it("fans out to every channel", async () => {
    const log: string[] = [];
    await new CompositeNotifier([ok(log, "console"), ok(log, "tmux")]).reviewReady(NOTICE);
    expect(log).toEqual(["console", "tmux"]);
  });

  it("succeeds when at least one channel delivered (the floor held)", async () => {
    const log: string[] = [];
    await new CompositeNotifier([ok(log, "console"), boom("ntfy")]).reviewReady(NOTICE);
    expect(log).toEqual(["console"]); // no throw — the signal can be stamped
  });

  it("throws only when EVERY channel failed, so the signal stays pending", async () => {
    const c = new CompositeNotifier([boom("tmux"), boom("ntfy")]);
    expect(c.reviewReady(NOTICE)).rejects.toThrow("every owner channel failed");
  });

  it("rejects an empty channel list", () => {
    expect(() => new CompositeNotifier([])).toThrow("no channels");
  });
});

describe("ownerNotifier (the composition-root factory)", () => {
  const CFG = { ntfyTopic: null, ntfyServer: "https://ntfy.sh" };

  it("is just the console floor with nothing configured", () => {
    expect(ownerNotifier(CFG).constructor.name).toBe("ConsoleNotifier");
  });

  it("composes tmux in when running inside the make-up session", () => {
    expect(ownerNotifier(CFG, { inTmux: true }).constructor.name).toBe("CompositeNotifier");
  });

  it("composes ntfy in when a topic is configured", () => {
    expect(ownerNotifier({ ...CFG, ntfyTopic: "fleet" }).constructor.name).toBe("CompositeNotifier");
  });
});
