// Run a named OpenCode agent in a worktree and collect its reply + token usage.
//
// The shared mechanism behind every dispatch leg: bind `serve` to the worktree (on a
// free port), create a session as the agent, drive the prompt, sum tokens across the
// whole agentic loop, then tear the server down. Two drive modes — `sync` blocks on
// the reply; `wake` fires prompt_async and waits for idle (the token-free wake,
// AGENT-8). The legs (build/review/amend) layer their git/GitHub work around this; the
// generic "run an agent" lives here, next to the client + serve it composes (ADR 0017).

import { AgentTimeoutError, OpencodeClient } from "./client";
import { startServe } from "./serve";

export type RunMode = "sync" | "wake";

export interface RunAgentOpts {
  /** The OpenCode agent to run the session as (e.g. the builder or reviewer route). */
  agent: string;
  /** The prompt to drive the agent with. */
  prompt: string;
  /** Session title (shows up in OpenCode). */
  title?: string;
  /** `sync` blocks on the reply; `wake` uses the token-free wake (idle-polling). Default `sync`. */
  mode?: RunMode;
  /** Idle window (ms): in `wake` mode, abort if the session produces no new activity for this
   *  long (a hang). Unset = the client default. */
  idleMs?: number;
  /** Absolute backstop (ms): abort a runaway session even while it's still producing. Also the
   *  hard cap for `sync` mode (which can't idle-detect). */
  absoluteMs?: number;
  /** Pin the session to a specific gateway route, overriding the agent's default model. Used by
   *  the builder-acceptance gate to drive a candidate route through the real `builder` persona
   *  (ADR 0025) without needing a per-route OpenCode agent. */
  model?: { providerID: string; id: string };
}

/** Run an agent's drive; if it times out, tear down the OpenCode session so a hung-and-still-
 *  generating session can't keep billing after the substrate escalates (AGENT-38 part 4).
 *  deleteSession is idempotent (404-safe); a teardown failure must not mask the timeout. */
export interface SessionKiller {
  deleteSession(id: string): Promise<void>;
}
export async function driveOrAbort<T>(client: SessionKiller, sessionID: string, drive: () => Promise<T>): Promise<T> {
  try {
    return await drive();
  } catch (err) {
    if (err instanceof AgentTimeoutError) await client.deleteSession(sessionID).catch(() => {});
    throw err;
  }
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
    const sessionID = await client.createSession({ title: opts.title, agent: opts.agent, model: opts.model });

    const start = Date.now();
    const reply = await driveOrAbort(client, sessionID, () =>
      (opts.mode ?? "sync") === "wake"
        ? runWake(client, sessionID, opts.prompt, opts.idleMs, opts.absoluteMs)
        : client.sendMessage(sessionID, opts.prompt, { timeoutMs: opts.absoluteMs }).then((r) => r.text),
    );
    const waitedMs = Date.now() - start;

    const tokens = await client.sessionTokens(sessionID);
    return { sessionId: sessionID, reply, tokens, waitedMs };
  } finally {
    serve.stop();
  }
}

// Fire the prompt without waiting, then poll for completion with idle detection — no tokens
// burn while the agent thinks, and a hang is caught on idle rather than a wall-clock cap.
async function runWake(
  client: OpencodeClient,
  sessionID: string,
  prompt: string,
  idleMs?: number,
  absoluteMs?: number,
): Promise<string> {
  await client.promptAsync(sessionID, prompt);
  return (await client.waitForReply(sessionID, { idleMs, absoluteMs })).text;
}
