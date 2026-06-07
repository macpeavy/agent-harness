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

export class OpencodeClient {
  constructor(private readonly baseUrl: string) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

  /** Send a prompt and block until the assistant reply completes. */
  async sendMessage(sessionID: string, text: string): Promise<AssistantReply> {
    const m = (await this.post(`/session/${sessionID}/message`, {
      parts: [{ type: "text", text }],
    })) as {
      info?: {
        modelID?: string;
        providerID?: string;
        finish?: string;
        tokens?: { input?: number; output?: number; total?: number };
        time?: { created?: number; completed?: number };
      };
      parts?: Array<{ type: string; text?: string }>;
    };

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
   * Poll until the session goes idle (its latest assistant message has finished),
   * then return that reply. This is *external* idle detection — the substrate waits,
   * not the agent, so no tokens are burned while idle (`/api/.../wait` is not yet
   * implemented server-side; `/event` SSE is the future cleaner path).
   */
  async waitForReply(
    sessionID: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<AssistantReply> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const intervalMs = opts.intervalMs ?? 1500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
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
      await Bun.sleep(intervalMs);
    }
    throw new Error(`waitForReply: session ${sessionID} did not idle within ${timeoutMs}ms`);
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
