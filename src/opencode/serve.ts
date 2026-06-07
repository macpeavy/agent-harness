// Spawn and manage an `opencode serve` instance bound to a working directory.
// `serve` has no --dir flag, so the working directory is set via the child's cwd —
// this is how the substrate runs a build in an isolated worktree while still
// driving the agent over HTTP (which AGENT-8's wake path reuses).

import { spawn } from "bun";
import { createServer } from "node:net";

export interface ServeHandle {
  baseUrl: string;
  stop: () => void;
}

// Ask the OS for a free TCP port (bind to 0, read the assignment, release), so
// concurrent dispatches each get their own serve without colliding on a fixed port.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("freePort: no port assigned"))));
    });
  });
}

/** Start `opencode serve` in `dir` and resolve once it answers /doc. A free port is
 *  allocated when one isn't given, so concurrent serves don't collide. */
export async function startServe(dir: string, port?: number): Promise<ServeHandle> {
  const boundPort = port ?? (await freePort());
  // Inherits process.env — the caller must have OPENROUTER_API_KEY + LITELLM_MASTER_KEY
  // in env (source .env) so the server can reach the gateway.
  const proc = spawn(["opencode", "serve", "--port", String(boundPort)], {
    cwd: dir,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  });

  const baseUrl = `http://localhost:${boundPort}`;
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
