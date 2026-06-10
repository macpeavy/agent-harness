// Driver heartbeats (AGENT-44) — a dead daemon/session-loop must not look like healthy
// in-flight work. Each driver process starts a Heartbeat at boot: a timer that writes its
// `last_seen` into the substrate db every interval. TIMER-based, not tick-based, on purpose:
// the daemon's tick blocks for a whole build leg (minutes), so a per-tick write would flag a
// healthy driver as dead mid-build — the legs are async, so the event loop keeps firing the
// timer underneath them. `status` / fleet-status assess the rows with assessHeartbeats and
// flag a stale driver ("appears down, last heartbeat 4m ago") instead of showing `building`
// work as silently healthy. Detection only — no supervisor/auto-restart here (the `make up`
// panes already HOLD on exit for the operator).

const DEFAULT_HEARTBEAT_MS = 10_000;

// Stale = no beat for this many intervals. 3 rides out a missed beat or two under db
// contention without calling a live driver dead; a genuinely dead one flags within ~30s
// at the default cadence.
const STALE_FACTOR = 3;

/** The slice of the runtime repository the writer needs. */
export interface HeartbeatStore {
  beat(driver: string, pid: number, intervalMs: number, startedAt: number): void;
}

/** One driver's assessed liveness — what the status surfaces render. */
export interface DriverHealth {
  driver: string;
  pid: number;
  /** ms since the last beat. */
  ageMs: number;
  /** True when the driver has missed STALE_FACTOR beats — treat as down. */
  stale: boolean;
}

/** A heartbeat row as the assessor needs it (structurally the runtime context's row). */
export interface HeartbeatRow {
  driver: string;
  pid: number;
  intervalMs: number;
  lastSeen: number;
}

/** Assess raw heartbeat rows into per-driver health. Pure — staleness is judged against
 *  each row's own recorded cadence, so readers need no shared config. */
export function assessHeartbeats(rows: HeartbeatRow[], now = Date.now()): DriverHealth[] {
  return rows.map((r) => {
    const ageMs = Math.max(0, now - r.lastSeen);
    return { driver: r.driver, pid: r.pid, ageMs, stale: ageMs > STALE_FACTOR * r.intervalMs };
  });
}

/** Compact age for a status line: 4s / 3m / 2h. */
export function formatAge(ageMs: number): string {
  const s = Math.round(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** The per-process heartbeat writer. Construct once at driver boot, `start()`, forget. */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly store: HeartbeatStore,
    private readonly driver: string,
    private readonly intervalMs: number = DEFAULT_HEARTBEAT_MS,
    private readonly pid: number = process.pid,
  ) {}

  /** Beat now and every interval. Idempotent — a second start is a no-op. */
  start(): void {
    if (this.timer) return;
    this.write();
    this.timer = setInterval(() => this.write(), this.intervalMs);
  }

  /** Stop beating (tests; drivers run until killed). The last row remains and goes stale —
   *  which is the honest signal: the driver IS down. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // A beat failure must never take the driver down with it (the heartbeat is the canary,
  // not the cage) — log and let the next interval retry.
  private write(): void {
    try {
      this.store.beat(this.driver, this.pid, this.intervalMs, this.startedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`heartbeat: ${this.driver} beat failed: ${message}`);
    }
  }
}
