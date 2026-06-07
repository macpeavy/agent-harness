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
}
