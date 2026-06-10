// The runtime tables — liveness/registration state for the running fleet (ADR 0024).
// Distinct from the plan (what to build) and the dispatch registry (build progress):
// these rows describe the PROCESSES around the build — where a live chief can be
// addressed. They share the substrate db so the loop reads them with the same handle.
// drizzle-kit generates migrations from this file.

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The live chief's address (ADR 0024) — written at chief launch so the session loop's
 * notify pass can wake it (`promptAsync`) when a session needs routing. A singleton row
 * (id 'chief'): the fleet assumes one chief at a time; re-launching replaces it.
 * Registration is best-effort and self-healing — a push to a stale row is swallowed and
 * the durable session state remains the floor (push accelerates pull, never replaces it).
 */
export const chiefRegistrations = sqliteTable("chief_registrations", {
  id: text("id").primaryKey(),
  /** The chief's OpenCode session id — the wake's target. */
  sessionId: text("session_id").notNull(),
  /** The OpenCode server the chief's session lives on (the launcher binds a known port). */
  baseUrl: text("base_url").notNull(),
  registeredAt: integer("registered_at").notNull(),
});

export type ChiefRegistration = InferSelectModel<typeof chiefRegistrations>;
export type NewChiefRegistration = InferInsertModel<typeof chiefRegistrations>;

/**
 * Driver liveness (AGENT-44) — one row per driver process (the dispatch daemon, the session
 * loop), refreshed on a timer while the process is up. `status`/fleet-status judge staleness
 * against the row's own interval (no shared config needed): a dispatch stuck in `building`
 * under a stale heartbeat is a dead driver, not healthy in-flight work. Rows are never
 * deleted — a stale row IS the signal (a clean shutdown leaving "stale" is honest: the
 * driver really is down).
 */
export const driverHeartbeats = sqliteTable("driver_heartbeats", {
  /** The driver's stable name — 'daemon' | 'session-loop'. */
  driver: text("driver").primaryKey(),
  pid: integer("pid").notNull(),
  /** The writer's beat cadence (ms) — staleness is age > a small multiple of this. */
  intervalMs: integer("interval_ms").notNull(),
  lastSeen: integer("last_seen").notNull(),
  /** When this process started beating (a restart resets it; pid disambiguates). */
  startedAt: integer("started_at").notNull(),
});

export type DriverHeartbeat = InferSelectModel<typeof driverHeartbeats>;
export type NewDriverHeartbeat = InferInsertModel<typeof driverHeartbeats>;
