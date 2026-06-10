// The chief launcher (ADR 0024) — start the chief client-server so the substrate can
// address it. The bare `opencode --agent chief` TUI hid the chief behind an embedded
// server on an unknown port, so the session loop's notify pass had no wake target. This
// launcher makes the address deterministic (ADR 0004's topology, applied to the chief):
//
//   1. create the chief's session over REST against a THROWAWAY `opencode serve` (the
//      session store is shared per project dir, so the TUI sees it) — this is how the
//      substrate learns the session id;
//   2. register { sessionId, baseUrl } in the substrate db (the runtime context) — the
//      notify pass reads this to `promptAsync` the chief on needs-attention;
//   3. hand the terminal to the TUI on the KNOWN port with the chief persona selected:
//      `opencode --port <AH_CHIEF_PORT> --session <id> --agent chief`. The TUI's own
//      embedded server is the wake target — no separate long-running serve. The --agent
//      flag matters: a session's REST-side agent doesn't drive the TUI's agent picker,
//      so without it the pane opens on the default build agent (the wrong seat);
//   4. on TUI exit: clear the registration (best-effort).
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

  // A throwaway serve, just to mint the session over REST — stopped before the TUI starts
  // (the TUI binds the real port itself). Bound to the repo root so the session lands in
  // the project's store, where the TUI will find it.
  const serve = await startServe(config.repoPath);
  let sessionId: string;
  try {
    sessionId = await new OpencodeClient(serve.baseUrl).createSession({ agent: "chief", title: "chief" });
  } finally {
    serve.stop();
  }

  // migrate: false — `make up` migrates once up front; a standalone `make chief` against a
  // fresh db needs `make migrate` first (same contract as the daemon + session-loop).
  const runtime = new RuntimeRepository(undefined, { migrate: false });
  try {
    runtime.registerChief({ sessionId, baseUrl: `http://localhost:${chiefPort}` });
    console.log(`chief session ${sessionId} registered at http://localhost:${chiefPort} — starting the TUI`);

    // The TUI is the server: known port (the registered wake target), the minted session,
    // and the chief persona selected.
    const tui = spawn(
      ["opencode", "--port", String(chiefPort), "--session", sessionId, "--agent", "chief"],
      {
        cwd: config.repoPath,
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    await tui.exited;
    runtime.clearChief(sessionId); // guarded: only removes the row if it's still ours
  } finally {
    runtime.close();
  }
}
