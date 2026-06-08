// Run a named OpenCode agent in a worktree and collect its reply + token usage.
//
// The shared mechanism behind every dispatch leg: bind `serve` to the worktree (on a
// free port), create a session as the agent, drive the prompt, sum tokens across the
// whole agentic loop, then tear the server down. Two drive modes — `sync` blocks on
// the reply; `wake` fires prompt_async and waits for idle (the token-free wake,
// AGENT-8). The legs (build/review/amend) layer their git/GitHub work around this; the
// generic "run an agent" lives here, next to the client + serve it composes (ADR 0017).

import { OpencodeClient } from "./client";
import { startServe } from "./serve";

export type RunMode = "sync" | "wake";

export interface RunAgentOpts {
  /** The OpenCode agent to run the session as (e.g. the builder or reviewer route). */
  agent: string;
  /** The prompt to drive the agent with. */
  prompt: string;
  /** Session title (shows up in OpenCode). */
  title?: string;
  /** `sync` blocks on the reply; `wake` uses the token-free wake. Default `sync`. */
  mode?: RunMode;
  /** Deadline (ms) for the model turn; on overrun the leg throws AgentTimeoutError, which the
   *  daemon escalates. Unset = the client's default ceiling. */
  timeoutMs?: number;
}

export interface AgentRun {
  /** The OpenCode session id — the registry links it onto the dispatch (ADR 0009). */
  sessionId: string;
  reply: string;
  tokens: { input: number; output: number };
  /** Wall time from prompt fired to reply collected (the idle wait, in `wake` mode). */
  waitedMs: number;
}

/** Run `opts.agent` against `worktree` and return its reply + token usage. */
export async function runAgent(worktree: string, opts: RunAgentOpts): Promise<AgentRun> {
  const serve = await startServe(worktree);
  try {
    const client = new OpencodeClient(serve.baseUrl);
    const sessionID = await client.createSession({ title: opts.title, agent: opts.agent });

    const start = Date.now();
    const reply =
      (opts.mode ?? "sync") === "wake"
        ? await runWake(client, sessionID, opts.prompt, opts.timeoutMs)
        : (await client.sendMessage(sessionID, opts.prompt, { timeoutMs: opts.timeoutMs })).text;
    const waitedMs = Date.now() - start;

    const tokens = await client.sessionTokens(sessionID);
    return { sessionId: sessionID, reply, tokens, waitedMs };
  } finally {
    serve.stop();
  }
}

// Fire the prompt without waiting, then let the substrate poll for idle — no tokens
// burn while the agent thinks.
async function runWake(client: OpencodeClient, sessionID: string, prompt: string, timeoutMs?: number): Promise<string> {
  await client.promptAsync(sessionID, prompt);
  return (await client.waitForReply(sessionID, { timeoutMs })).text;
}
