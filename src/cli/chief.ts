// The chief launcher (ADR 0024) — start the chief client-server so the substrate can
// address it. The bare `opencode --agent chief` TUI hid the chief behind an embedded
// server on an unknown port, so the session loop's notify pass had no wake target. This
// launcher makes the address deterministic (ADR 0004's topology, applied to the chief):
//
//   1. start a persistent `opencode serve` on a known port (AH_CHIEF_PORT, default 4096);
//   2. create the chief's session over REST — so the substrate knows the session id;
//   3. register { sessionId, baseUrl } in the substrate db (the runtime context) — the
//      notify pass reads this to `promptAsync` the chief on needs-attention;
//   4. attach the TUI to that exact session (`opencode attach <url> --session <id>`);
//   5. on TUI exit: clear the registration (best-effort) and stop the server.
//
// Registration is best-effort and self-healing (ADR 0024): if this process dies without
// cleanup, the stale row's failed pushes are swallowed by the notify pass, and the next
// launch replaces the row. Run:  bun run src/cli/chief.ts   (or `make chief` — needs .env)

import { spawn } from "bun";
import { loadConfig } from "../config";
import { OpencodeClient } from "../opencode/client";
import { startServe } from "../opencode/serve";
import { RuntimeRepository } from "../substrate/runtime";

// A positive integer from env, or the fallback (mirrors config.ts's intFromEnv).
function port(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

if (import.meta.main) {
  const config = await loadConfig();
  const chiefPort = port(process.env.AH_CHIEF_PORT, 4096);

  // The chief's server lives in the repo root (project context + the substrate MCP config),
  // unlike the per-dispatch serves the legs bind to worktrees.
  const serve = await startServe(config.repoPath, chiefPort);
  const client = new OpencodeClient(serve.baseUrl);

  // migrate: false — `make up` migrates once up front; a standalone `make chief` against a
  // fresh db needs `make migrate` first (same contract as the daemon + session-loop).
  const runtime = new RuntimeRepository(undefined, { migrate: false });

  try {
    const sessionId = await client.createSession({ agent: "chief", title: "chief" });
    runtime.registerChief({ sessionId, baseUrl: serve.baseUrl });
    console.log(`chief session ${sessionId} registered at ${serve.baseUrl} — attaching`);

    // Hand the terminal to the TUI, attached to the exact session the substrate registered.
    const tui = spawn(["opencode", "attach", serve.baseUrl, "--session", sessionId], {
      cwd: config.repoPath,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await tui.exited;
    runtime.clearChief(sessionId); // guarded: only removes the row if it's still ours
  } finally {
    runtime.close();
    serve.stop();
  }
}
