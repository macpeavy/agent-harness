import { describe, expect, it } from "bun:test";
import { assessHeartbeats, formatAge, Heartbeat, type HeartbeatRow } from "./heartbeat";

function row(over: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return { driver: "daemon", pid: 123, intervalMs: 10_000, lastSeen: 100_000, ...over };
}

describe("assessHeartbeats", () => {
  it("a fresh beat is not stale", () => {
    const [d] = assessHeartbeats([row()], 100_000 + 5_000);
    expect(d?.stale).toBe(false);
    expect(d?.ageMs).toBe(5_000);
  });

  it("flags stale only past 3× the row's own interval", () => {
    const atBoundary = assessHeartbeats([row()], 100_000 + 30_000)[0];
    expect(atBoundary?.stale).toBe(false); // exactly 3× — still within tolerance

    const past = assessHeartbeats([row()], 100_000 + 30_001)[0];
    expect(past?.stale).toBe(true);
  });

  it("judges each row against its own cadence", () => {
    const now = 200_000;
    const fastStale = row({ driver: "a", intervalMs: 1_000, lastSeen: now - 10_000 }); // 10× behind
    const slowFine = row({ driver: "b", intervalMs: 60_000, lastSeen: now - 10_000 }); // well within
    const [a, b] = assessHeartbeats([fastStale, slowFine], now);
    expect(a?.stale).toBe(true);
    expect(b?.stale).toBe(false);
  });

  it("a clock skew (lastSeen in the future) clamps to age 0, not negative", () => {
    const [d] = assessHeartbeats([row({ lastSeen: 500_000 })], 100_000);
    expect(d?.ageMs).toBe(0);
    expect(d?.stale).toBe(false);
  });
});

describe("formatAge", () => {
  it("renders seconds, minutes, hours compactly", () => {
    expect(formatAge(4_000)).toBe("4s");
    expect(formatAge(240_000)).toBe("4m");
    expect(formatAge(7_200_000)).toBe("2h");
  });
});

describe("Heartbeat", () => {
  it("beats immediately on start, then on the interval, with a stable startedAt", async () => {
    const beats: { driver: string; pid: number; intervalMs: number; startedAt: number }[] = [];
    const hb = new Heartbeat(
      { beat: (driver, pid, intervalMs, startedAt) => void beats.push({ driver, pid, intervalMs, startedAt }) },
      "daemon",
      5, // 5ms cadence so the test stays fast
      42,
    );

    hb.start();
    expect(beats.length).toBe(1); // the immediate beat — no blind first interval
    await Bun.sleep(20);
    hb.stop();

    expect(beats.length).toBeGreaterThanOrEqual(2); // the timer kept beating
    expect(beats[0]?.driver).toBe("daemon");
    expect(beats[0]?.pid).toBe(42);
    expect(new Set(beats.map((b) => b.startedAt)).size).toBe(1); // one process, one start time

    const after = beats.length;
    await Bun.sleep(15);
    expect(beats.length).toBe(after); // stop() really stopped it
  });

  it("a second start is a no-op (one timer per process)", async () => {
    let count = 0;
    const hb = new Heartbeat({ beat: () => void count++ }, "daemon", 1_000);
    hb.start();
    hb.start();
    expect(count).toBe(1); // not two immediate beats
    hb.stop();
  });

  it("a throwing store never takes the driver down — the beat failure is contained", () => {
    const hb = new Heartbeat(
      {
        beat: () => {
          throw new Error("SQLITE_BUSY");
        },
      },
      "daemon",
      1_000,
    );
    expect(() => hb.start()).not.toThrow();
    hb.stop();
  });
});
