// Minimal typed client for the OpenCode server REST API (`opencode serve`).
// Seed of the substrate's OpenCode integration layer — AGENT-7/8 grow this into
// the dispatch + wake driver. Kept small and dependency-free (Bun's fetch).

export interface CreateSessionOpts {
  title?: string;
  /** Run the session as a named agent (e.g. "builder"), applying its prompt + route + permissions. */
  agent?: string;
  /** Pin the session to a specific gateway route, e.g. { providerID: "litellm", id: "builder" }. */
  model?: { providerID: string; id: string };
  /** Set for a child (sub-agent) session. */
  parentID?: string;
}

export interface AssistantReply {
  text: string;
  modelID: string;
  providerID: string;
  finish: string;
  tokens: { input: number; output: number; total: number };
  /** Server-reported created→completed latency in ms. */
  serverMs: number;
}

/** Why a wait aborted (AGENT-38): `idle` — no new activity for the idle window (a hang);
 *  `absolute` — the runaway backstop tripped even while still producing. */
export type TimeoutKind = "idle" | "absolute";

/**
 * A model turn aborted on a deadline (a hung session, or a runaway one). A distinct type so the
 * daemon routes it into the escalation path (parked, chief-visible) instead of a hard fail or an
 * unhandled throw (ADR 0023 row 3). `kind` distinguishes an idle hang from the absolute backstop.
 */
export class AgentTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly timeoutMs: number,
    readonly kind: TimeoutKind = "absolute",
  ) {
    super(
      kind === "idle"
        ? `agent session ${sessionId} produced no activity for ${timeoutMs}ms (idle)`
        : `agent session ${sessionId} exceeded the ${timeoutMs}ms absolute backstop`,
    );
    this.name = "AgentTimeoutError";
  }
}

/**
 * The session is blocked on a permission prompt a headless run can't answer (e.g. the agent tried
 * an action that's neither allowed nor denied by the persona's permission set). OpenCode pauses
 * the turn waiting for a reply that will never come — so the substrate aborts with WHAT it was
 * blocked on, rather than waiting out a timeout and mislabeling it. A distinct type so the daemon
 * routes it honestly (parked, attended) instead of as a generic leg error (ADR 0023).
 */
export class AgentBlockedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly detail: string,
  ) {
    super(`agent session ${sessionId} blocked on a permission prompt a headless run can't answer: ${detail}`);
    this.name = "AgentBlockedError";
  }
}

/** OpenCode's authoritative per-session status (GET /session/status): `busy` — actively
 *  processing the turn; `retry` — retrying after a provider hiccup (still alive); `idle` — not
 *  working (the turn finished, never started, or wedged). The wake driver trusts this instead of
 *  inferring liveness from message growth. */
export type SessionStatusType = "idle" | "busy" | "retry";

/** What a single wait poll concludes, ignoring elapsed time (the loop layers the idle/absolute
 *  deadlines on top). Pure, so the decision is unit-testable without a server. */
export type PollOutcome =
  | { kind: "done" } // a finished assistant reply is present → return it
  | { kind: "blocked"; detail: string } // a permission is pending → a headless run can't proceed
  | { kind: "working" } // the server reports the agent actively processing (busy/retry) → alive
  | { kind: "stalled" }; // not working and not done → a real stall if it persists (idle abort)

/**
 * Classify one poll from the AUTHORITATIVE signals (ADR 0026 wake hardening): is the turn done, is
 * it blocked on a permission, is the server actively working it, or is it stalled? Liveness comes
 * from OpenCode's own session status — NOT from inferring "no message growth", which falsely killed
 * a working-but-quiet agent (the reviewer mid-`git diff`). `activityMoved` is only the fallback
 * when the status endpoint is unavailable (an older server): then we degrade to the message-growth
 * proxy rather than abort blindly.
 */
export function classifyPoll(o: {
  finished: boolean;
  pendingPermission: string | null;
  status: SessionStatusType | null;
  activityMoved?: boolean;
}): PollOutcome {
  if (o.finished) return { kind: "done" };
  if (o.pendingPermission) return { kind: "blocked", detail: o.pendingPermission };
  if (o.status === "busy" || o.status === "retry") return { kind: "working" };
  if (o.status === null && o.activityMoved) return { kind: "working" }; // fallback liveness
  return { kind: "stalled" };
}

/** A cheap measure of how much a session has produced — a change between polls means the agent is
 *  still working (resets the idle clock); no change means it's stalled.
 *
 *  It counts ALL part activity, not just text: messages, the number of parts, and each part's
 *  payload size (text length for text parts, serialized size otherwise). The earlier version summed
 *  only `text` length + message count, which was BLIND to tool-call and tool-result parts — so a
 *  tool-heavy agent (above all the reviewer, which spends its turns running `git diff` and reading
 *  files, emitting little text until the final verdict) looked idle while actively working and got
 *  killed at the idle window. Counting parts + their content means a new tool call, a tool result,
 *  or a step marker all register as progress; a genuinely stalled session (no parts changing) still
 *  idles, and the absolute backstop still caps a runaway. Pure, so the idle logic is testable.
 *  (`/event` SSE is the future cleaner activity source — see waitForReply.) */
export function activitySignature(msgs: { parts?: unknown[] }[]): number {
  let sig = msgs.length;
  for (const m of msgs) {
    const parts = m.parts ?? [];
    sig += parts.length; // a new part (tool call, tool result, step boundary) is progress
    for (const p of parts) sig += partActivitySize(p);
  }
  return sig;
}

/** A part's contribution to the activity signature: text length for a text part, else the part's
 *  serialized size (which grows as a tool part appears and transitions running → completed, and as
 *  its output fills in). Falls back to 1 for an unserializable/non-object part so it still counts. */
function partActivitySize(part: unknown): number {
  if (part && typeof part === "object") {
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") return text.length;
    try {
      return JSON.stringify(part).length;
    } catch {
      return 1;
    }
  }
  return 1;
}

/** Whether a poll should abort, and why (AGENT-38 idle detection): `absolute` if the total wait
 *  exceeded the backstop, `idle` if there's been no activity for the idle window, else null
 *  (keep waiting). Pure. Activity keeps `lastActivity` fresh, so a slow-but-progressing session
 *  is never killed on idle — only the absolute backstop can stop it. */
export function timeoutKind(
  now: number,
  start: number,
  lastActivity: number,
  idleMs: number,
  absoluteMs: number,
): TimeoutKind | null {
  if (now - start >= absoluteMs) return "absolute";
  if (now - lastActivity >= idleMs) return "idle";
  return null;
}

export class OpencodeClient {
  constructor(private readonly baseUrl: string) {}

  // POST with an optional deadline. On a timeout the AbortSignal fires and fetch throws an
  // AbortError; the caller (sendMessage) maps that to AgentTimeoutError. No timeout = no signal
  // (the prior behavior), so unrelated POSTs are unaffected.
  private async post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) {
      throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Create a session; returns its id (`ses_...`). */
  async createSession(opts: CreateSessionOpts = {}): Promise<string> {
    const s = (await this.post("/session", opts)) as { id?: string };
    if (!s?.id) throw new Error(`createSession: no id in response (${JSON.stringify(s)})`);
    return s.id;
  }

  /**
   * Delete a session and all its data (the terminal reaper, ADR 0009/0019). Idempotent:
   * a 404 (already gone) is treated as success, so re-running a sweep is safe. Other
   * non-OK statuses still throw — a real failure shouldn't be silently swallowed.
   */
  async deleteSession(sessionID: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${sessionID}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`DELETE /session/${sessionID} → ${res.status} ${await res.text()}`);
    }
  }

  /** Send a prompt and block until the assistant reply completes, up to `opts.timeoutMs` (no
   *  cap if unset). A timeout aborts the request and throws AgentTimeoutError. */
  async sendMessage(sessionID: string, text: string, opts: { timeoutMs?: number } = {}): Promise<AssistantReply> {
    type MessageResponse = {
      info?: {
        modelID?: string;
        providerID?: string;
        finish?: string;
        tokens?: { input?: number; output?: number; total?: number };
        time?: { created?: number; completed?: number };
      };
      parts?: Array<{ type: string; text?: string }>;
    };

    let m: MessageResponse;
    try {
      m = (await this.post(`/session/${sessionID}/message`, { parts: [{ type: "text", text }] }, opts.timeoutMs)) as MessageResponse;
    } catch (err) {
      // AbortSignal.timeout fires a DOMException named "TimeoutError" (or "AbortError"); map it
      // to the typed timeout so the daemon escalates instead of hard-failing.
      if (opts.timeoutMs && err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
        throw new AgentTimeoutError(sessionID, opts.timeoutMs);
      throw err;
    }

    const info = m.info ?? {};
    const textPart = (m.parts ?? []).find((p) => p.type === "text");
    const created = info.time?.created;
    const completed = info.time?.completed;

    return {
      text: (textPart?.text ?? "").trim(),
      modelID: info.modelID ?? "?",
      providerID: info.providerID ?? "?",
      finish: info.finish ?? "?",
      tokens: {
        input: info.tokens?.input ?? 0,
        output: info.tokens?.output ?? 0,
        total: info.tokens?.total ?? 0,
      },
      serverMs: created && completed ? completed - created : 0,
    };
  }

  /** Fire a prompt without waiting — the token-free wake. Returns 204, no body. */
  async promptAsync(sessionID: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${sessionID}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
    if (!res.ok) throw new Error(`prompt_async → ${res.status} ${await res.text()}`);
  }

  /**
   * Wait for the session's turn to finish, then return that reply. External waiting — the
   * substrate polls, not the agent, so no tokens burn while it thinks.
   *
   * Liveness is AUTHORITATIVE, not inferred (ADR 0026 wake hardening, supersedes the AGENT-38
   * activity-signature heuristic): each poll asks OpenCode's own `/session/status`. While the
   * server reports `busy`/`retry` the agent is working and is NEVER aborted — however long a single
   * model call or a quiet tool (`git diff`, file reads) takes. The old heuristic inferred "hung"
   * from "no message growth" and so killed a working-but-quiet agent (the reviewer mid-diff); this
   * cannot. The idle deadline now means what it says: the server reports the session NOT working
   * AND it hasn't finished, sustained for `idleMs` — a genuine stall (crashed mid-turn, or the
   * prompt never got picked up). A pending permission is a dead end in a headless run (nothing will
   * answer it), so we abort on it immediately with what it asked for, rather than waiting it out and
   * mislabeling it. A generous `absoluteMs` backstop still caps a true runaway. Falls back to the
   * activity signature only when `/session/status` is unavailable (an older server).
   */
  async waitForReply(
    sessionID: string,
    opts: { idleMs?: number; absoluteMs?: number; intervalMs?: number } = {},
  ): Promise<AssistantReply> {
    const idleMs = opts.idleMs ?? 120_000;
    const absoluteMs = opts.absoluteMs ?? 1_800_000;
    const intervalMs = opts.intervalMs ?? 1500;
    const start = Date.now();
    let lastWorking = start; // last time the server reported the agent working (or, in fallback, activity moved)
    let lastSig = -1;

    while (true) {
      const msgs = (await this.get(`/session/${sessionID}/message`)) as Array<{
        info?: {
          role?: string;
          finish?: string;
          modelID?: string;
          providerID?: string;
          tokens?: { input?: number; output?: number; total?: number };
          time?: { created?: number; completed?: number };
        };
        parts?: Array<{ type: string; text?: string }>;
      }>;
      const assistants = (msgs ?? []).filter((m) => m.info?.role === "assistant");
      const last = assistants[assistants.length - 1];
      const finished = Boolean(last?.info?.finish);

      const status = await this.sessionStatus(sessionID);
      // The activity signature is now ONLY the fallback liveness when status is unavailable.
      const sig = activitySignature(msgs ?? []);
      const activityMoved = sig !== lastSig;
      lastSig = sig;
      const pendingPermission = finished ? null : await this.pendingPermission(sessionID);

      const outcome = classifyPoll({ finished, pendingPermission, status, activityMoved });
      if (outcome.kind === "done") return this.replyFrom(last!);
      if (outcome.kind === "blocked") throw new AgentBlockedError(sessionID, outcome.detail);
      if (outcome.kind === "working") lastWorking = Date.now();

      // Deadlines: idle = not-working-and-not-done for the whole window; absolute = the runaway cap.
      const now = Date.now();
      if (now - lastWorking >= idleMs) throw new AgentTimeoutError(sessionID, idleMs, "idle");
      if (now - start >= absoluteMs) throw new AgentTimeoutError(sessionID, absoluteMs, "absolute");
      await Bun.sleep(intervalMs);
    }
  }

  /** Extract the AssistantReply from a finished assistant message. */
  private replyFrom(msg: {
    info?: {
      modelID?: string;
      providerID?: string;
      finish?: string;
      tokens?: { input?: number; output?: number; total?: number };
      time?: { created?: number; completed?: number };
    };
    parts?: Array<{ type: string; text?: string }>;
  }): AssistantReply {
    const info = msg.info ?? {};
    const text = (msg.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    const created = info.time?.created;
    const completed = info.time?.completed;
    return {
      text,
      modelID: info.modelID ?? "?",
      providerID: info.providerID ?? "?",
      finish: info.finish ?? "?",
      tokens: { input: info.tokens?.input ?? 0, output: info.tokens?.output ?? 0, total: info.tokens?.total ?? 0 },
      serverMs: created && completed ? completed - created : 0,
    };
  }

  /** OpenCode's authoritative status for a session (GET /session/status → a map keyed by id).
   *  `busy`/`retry`/`idle`, or null when the session isn't listed or the endpoint is unavailable
   *  (an older server) — the caller degrades to the activity-signature fallback on null. The wake
   *  driver's liveness signal: the server says whether it's working, so we don't have to guess. */
  async sessionStatus(sessionID: string): Promise<SessionStatusType | null> {
    try {
      const all = (await this.get(`/session/status`)) as Record<string, { type?: string } | undefined>;
      const t = all?.[sessionID]?.type;
      return t === "idle" || t === "busy" || t === "retry" ? t : null;
    } catch {
      return null; // endpoint unavailable → caller falls back to the activity signature
    }
  }

  /** A short description of the first pending permission for a session, or null if none
   *  (GET /api/session/:id/permission/request). A pending permission in a headless run is a dead
   *  end — nothing will answer it — so the wake driver aborts on it rather than waiting out the
   *  idle window. Best-effort: any read error → null (treated as "no pending permission"). */
  async pendingPermission(sessionID: string): Promise<string | null> {
    try {
      const res = (await this.get(`/api/session/${sessionID}/permission/request`)) as {
        data?: Array<{ action?: string; resources?: string[] }>;
      };
      const first = res?.data?.[0];
      if (!first) return null;
      const resources = first.resources?.length ? ` ${first.resources.join(", ")}` : "";
      return `${first.action ?? "permission"}${resources}`;
    } catch {
      return null;
    }
  }

  /** The raw messages of a session — for inspecting what the agent actually did (e.g. the
   *  builder-acceptance gate checking for a real write/edit tool call vs text-emitted output).
   *  Read-only; resolves by session id. Parts carry a `type` and tool-specific fields. */
  async messages(sessionID: string): Promise<
    Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string; [k: string]: unknown }> }>
  > {
    return (await this.get(`/session/${sessionID}/message`)) as Array<{
      info?: { role?: string };
      parts?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
    }>;
  }

  /** Sum input/output tokens across every assistant message in a session (the full
   *  agentic loop, not just the final turn) — the basis for per-session cost. */
  async sessionTokens(sessionID: string): Promise<{ input: number; output: number }> {
    const msgs = (await this.get(`/session/${sessionID}/message`)) as Array<{
      info?: { role?: string; tokens?: { input?: number; output?: number } };
    }>;
    let input = 0;
    let output = 0;
    for (const m of msgs ?? []) {
      if (m.info?.role === "assistant") {
        input += m.info.tokens?.input ?? 0;
        output += m.info.tokens?.output ?? 0;
      }
    }
    return { input, output };
  }
}
