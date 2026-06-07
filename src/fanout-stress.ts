// AGENT-6 / gate G1 — fan-out stress test.
//
// Spawns an N-wide fan-out of concurrent sessions across distinct LiteLLM routes
// via the OpenCode server API and checks that they run *concurrently* (not
// serialized), all complete, and show no errors across multiple rounds.
//
// Why this is the spike's central risk: OpenCode's background/parallel subagent
// path is experimental. This test drives concurrency the way the substrate will
// (sessions over the REST API, each pinned to a route) — which sidesteps the
// experimental task-tool path entirely. If it holds, the fleet's concurrency
// model is sound.
//
// Run: bun run src/fanout-stress.ts   (needs `opencode serve` + the gateway up)
// Env: OPENCODE_BASE (default http://localhost:4096), FANOUT_ROUNDS (default 3)

import { OpencodeClient } from "./opencode/client";

const BASE = process.env.OPENCODE_BASE ?? "http://localhost:4096";
const ROUNDS = Number(process.env.FANOUT_ROUNDS ?? 3);
const PROMPT = "Reply with exactly: OK";

// N-wide fan-out; repeats span all three distinct routes.
const ROUTES = ["builder", "builder-alt", "reviewer", "builder", "builder-alt"];
// Concurrency signal: the batch finishes in ~the slowest single task's time
// (wall ≈ max). Serialized execution would give wall ≈ sum. A fixed sum/wall
// ratio is unreliable because LLM latencies are uneven — one slow task pins
// wall high even under full concurrency — so we compare wall to max, not sum.
const WALL_OVER_MAX_TOLERANCE = 1.5;

interface Outcome {
  route: string;
  ok: boolean;
  text: string;
  ms: number;
  modelID?: string;
  err?: string;
}

async function runOne(client: OpencodeClient, route: string): Promise<Outcome> {
  const start = Date.now();
  try {
    const sid = await client.createSession({
      title: `fanout-${route}`,
      model: { providerID: "litellm", id: route },
    });
    const reply = await client.sendMessage(sid, PROMPT);
    return { route, ok: reply.text.length > 0, text: reply.text, ms: Date.now() - start, modelID: reply.modelID };
  } catch (e) {
    return { route, ok: false, text: "", ms: Date.now() - start, err: String(e) };
  }
}

async function round(client: OpencodeClient, n: number): Promise<boolean> {
  const wallStart = Date.now();
  const outcomes = await Promise.all(ROUTES.map((r) => runOne(client, r)));
  const wall = Date.now() - wallStart;
  const sum = outcomes.reduce((a, o) => a + o.ms, 0);
  const max = Math.max(...outcomes.map((o) => o.ms));
  const ratio = sum / wall;
  const allOk = outcomes.every((o) => o.ok);
  // wall ≈ max ⇒ ran concurrently; wall ≈ sum ⇒ serialized.
  const concurrent = wall <= max * WALL_OVER_MAX_TOLERANCE;

  console.log(`\n── round ${n} ──`);
  for (const o of outcomes) {
    const tail = o.err ?? `→ ${o.modelID} "${o.text}"`;
    console.log(`  ${o.ok ? "✓" : "✗"} ${o.route.padEnd(12)} ${String(o.ms).padStart(6)}ms  ${tail}`);
  }
  console.log(
    `  wall=${wall}ms max=${max}ms sum=${sum}ms (${ratio.toFixed(2)}x) → ` +
      `${concurrent ? "concurrent" : "SERIALIZED"}; all-ok=${allOk}`,
  );
  return allOk && concurrent;
}

async function main() {
  const client = new OpencodeClient(BASE);
  const distinct = [...new Set(ROUTES)];
  console.log(
    `fan-out stress (G1): ${ROUTES.length}-wide on distinct routes [${distinct.join(", ")}], ` +
      `${ROUNDS} rounds, base ${BASE}`,
  );

  let pass = true;
  for (let i = 1; i <= ROUNDS; i++) {
    pass = (await round(client, i)) && pass;
  }

  console.log(`\nG1 ${pass ? "PASS" : "FAIL"} — ${ROUNDS} rounds of ${ROUTES.length}-wide fan-out on distinct routes`);
  process.exit(pass ? 0 : 1);
}

main();
