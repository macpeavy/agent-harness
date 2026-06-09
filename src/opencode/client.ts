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

/** A cheap measure of how much a session has produced — message count plus total text length
 *  across all parts. A change between polls means the agent is still working (resets the idle
 *  clock); no change means it's stalled. Pure, so the idle logic is testable. */
export function activitySignature(msgs: { parts?: { text?: string }[] }[]): number {
  let sig = msgs.length;
  for (const m of msgs) for (const p of m.parts ?? []) sig += p.text?.length ?? 0;
  return sig;
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
   * Poll until the session's latest assistant message has finished, then return that reply. This
   * is *external* waiting — the substrate polls, not the agent, so no tokens burn while it thinks.
   *
   * Aborts on IDLE, not a fixed wall-clock (AGENT-38): if the session produces no new activity for
   * `idleMs` it's a hang → AgentTimeoutError(idle). A generous `absoluteMs` backstop still kills a
   * runaway session that keeps producing forever. A slow-but-progressing build is NOT killed — its
   * activity keeps resetting the idle clock. (`/event` SSE is the future cleaner activity source.)
   */
  async waitForReply(
    sessionID: string,
    opts: { idleMs?: number; absoluteMs?: number; intervalMs?: number } = {},
  ): Promise<AssistantReply> {
    const idleMs = opts.idleMs ?? 120_000;
    const absoluteMs = opts.absoluteMs ?? 1_800_000;
    const intervalMs = opts.intervalMs ?? 1500;
    const start = Date.now();
    let lastActivity = start;
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
      // Any growth in the message stream = the agent is still working → reset the idle clock.
      const sig = activitySignature(msgs ?? []);
      if (sig !== lastSig) {
        lastActivity = Date.now();
        lastSig = sig;
      }
      const assistants = (msgs ?? []).filter((m) => m.info?.role === "assistant");
      const last = assistants[assistants.length - 1];
      if (last?.info?.finish) {
        const info = last.info;
        const text = (last.parts ?? [])
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
          tokens: {
            input: info.tokens?.input ?? 0,
            output: info.tokens?.output ?? 0,
            total: info.tokens?.total ?? 0,
          },
          serverMs: created && completed ? completed - created : 0,
        };
      }
      const kind = timeoutKind(Date.now(), start, lastActivity, idleMs, absoluteMs);
      if (kind) throw new AgentTimeoutError(sessionID, kind === "idle" ? idleMs : absoluteMs, kind);
      await Bun.sleep(intervalMs);
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
