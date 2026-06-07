// Spawn and manage an `opencode serve` instance bound to a working directory.
// `serve` has no --dir flag, so the working directory is set via the child's cwd —
// this is how the substrate runs a build in an isolated worktree while still
// driving the agent over HTTP (which AGENT-8's wake path reuses).

import { spawn } from "bun";

export interface ServeHandle {
  baseUrl: string;
  stop: () => void;
}

/** Start `opencode serve` in `dir` on `port` and resolve once it answers /doc. */
export async function startServe(dir: string, port = 4097): Promise<ServeHandle> {
  // Inherits process.env — the caller must have OPENROUTER_API_KEY + LITELLM_MASTER_KEY
  // in env (source .env) so the server can reach the gateway.
  const proc = spawn(["opencode", "serve", "--port", String(port)], {
    cwd: dir,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  });

  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/doc`);
      if (res.ok) return { baseUrl, stop: () => proc.kill() };
    } catch {
      // not up yet
    }
    await Bun.sleep(400);
  }
  proc.kill();
  throw new Error(`opencode serve did not become ready on ${baseUrl} within 30s`);
}
