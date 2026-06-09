// The builder-acceptance gate (ADR 0025) — prove a model can actually build before it's wired
// as the `builder` route. It drives the REAL build leg (runBuildLeg, in-repo worktree + idle
// abort — depends on AGENT-38) against a canned trivial chunk that REQUIRES a write, then asserts
// the model produced a real, typechecking file change under a tight budget. A model that no-ops
// (Mistral: changed:false), text-emits its tool calls (qwen), or empty-loops (Mistral's 50-turn
// spin) FAILS — and must never be wired. Policy (ADR 0025): the builder route ships only with a
// recorded green gate run.
//
// Run:  make gate-builder ROUTE=builder   (needs the gateway up + env)
//       bun run src/cli/gate-builder.ts [route]

import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config";
import { estimateCost } from "../dispatch/cost";
import { dispatchBranch, runBuildLeg, type Issue } from "../dispatch/legs/build";
import { removeWorktree } from "../dispatch/legs/worktree";
import { startServe } from "../opencode/serve";
import { OpencodeClient, AgentTimeoutError } from "../opencode/client";

const COST_CEIL_USD = 0.1; // ADR 0025 assertion 4 — a real build of a one-liner is far under this
const GATE_IDLE_MS = 60_000; // tighter than the build default — a dud should die fast
const GATE_SURFACE = "src/_gate/touch.ts";
const GATE_CONTENT = "export const GATE_OK = true;";

/** The measured signals from a gate run — the pure inputs to the verdict (so the verdict logic
 *  is testable without a model). */
export interface GateSignals {
  changed: boolean; // assertion 1 — a non-empty diff
  fileExists: boolean; // assertion 2a — the target file is in the produced change
  typechecks: boolean; // assertion 2b — and it typechecks
  /** assertion 3 — a real write/edit tool call was found in the session; null = couldn't inspect
   *  (defer to assertion 1, which a real file change already implies a real tool call). */
  wroteViaTool: boolean | null;
  costUsd: number; // assertion 4 — under the budget ceiling
  timedOut: boolean; // assertion 4 — idle/backstop abort = hang / empty-loop
}

export interface GateVerdict {
  pass: boolean;
  failures: string[];
}

/** Evaluate the gate from measured signals (ADR 0025 assertions 1–4). Pure. Assertion 1
 *  (a real diff) is the load-bearing guard: a text-emitted "tool call" can't change a file, so
 *  `changed === true` already implies a real write tool call — assertion 3 is positive
 *  confirmation when the session is inspectable, never a false-fail when it isn't. */
export function evaluateGate(s: GateSignals, costCeil = COST_CEIL_USD): GateVerdict {
  const failures: string[] = [];
  if (s.timedOut) failures.push("4 (budget): the build hung / empty-looped — idle or backstop timeout");
  if (!s.changed) failures.push("1 (diff): empty diff — the model produced no file change (changed:false)");
  if (s.changed && !s.fileExists) failures.push(`2 (file): ${GATE_SURFACE} is not in the produced change`);
  if (s.changed && s.fileExists && !s.typechecks) failures.push(`2 (typecheck): ${GATE_SURFACE} does not typecheck`);
  if (s.wroteViaTool === false)
    failures.push("3 (tool-call): no write/edit tool call — output was text-emitted, not a real tool call");
  if (s.costUsd >= costCeil) failures.push(`4 (cost): $${s.costUsd.toFixed(4)} ≥ ceiling $${costCeil.toFixed(2)}`);
  return { pass: failures.length === 0, failures };
}

/** Did the session make a real write/edit tool call? true = found; false = inspectable but none;
 *  null = couldn't read the session (defer to assertion 1). Version-resilient: a tool part names
 *  its tool somewhere in its shape, so we match write/edit/create/patch in a `tool`-typed part. */
async function inspectToolCalls(repoPath: string, sessionId: string): Promise<boolean | null> {
  const serve = await startServe(repoPath);
  try {
    const client = new OpencodeClient(serve.baseUrl);
    const msgs = await client.messages(sessionId);
    const parts = msgs.flatMap((m) => m.parts ?? []);
    if (parts.length === 0) return null; // session not inspectable from here — defer to assertion 1
    const isWriteTool = (p: { type?: string }) =>
      /tool/i.test(p.type ?? "") && /"(write|edit|create|patch)"/i.test(JSON.stringify(p));
    return parts.some(isWriteTool);
  } catch {
    return null; // couldn't query — defer
  } finally {
    serve.stop();
  }
}

/** Assertion 2: fetch the pushed gate branch into a scratch worktree and confirm the file is
 *  there and the project typechecks with it. Returns {fileExists, typechecks}. */
async function verifyBranch(repoPath: string, branch: string): Promise<{ fileExists: boolean; typechecks: boolean }> {
  const scratch = join(repoPath, ".worktrees", "gate-verify");
  await removeWorktree(repoPath, scratch);
  await $`git -C ${repoPath} fetch origin ${branch}`.nothrow().quiet();
  const added = await $`git -C ${repoPath} worktree add ${scratch} origin/${branch}`.nothrow().quiet();
  if (added.exitCode !== 0) return { fileExists: false, typechecks: false };
  try {
    const fileExists = existsSync(join(scratch, GATE_SURFACE));
    if (!fileExists) return { fileExists: false, typechecks: false };
    const tc = await $`bun run typecheck`.cwd(scratch).nothrow().quiet();
    return { fileExists: true, typechecks: tc.exitCode === 0 };
  } finally {
    await removeWorktree(repoPath, scratch);
  }
}

async function runGate(route: string): Promise<void> {
  // The gate drives the real `builder` persona (the OpenCode agent that ships) but pins the
  // model to the candidate litellm route (ADR 0025) — so ROUTE targets the gateway route
  // directly, no per-route OpenCode agent needed and independent of the checked-out config.
  const config = { ...(await loadConfig()), agentIdleMs: GATE_IDLE_MS };
  const model = { providerID: "litellm", id: route };
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const issue: Issue = {
    id: `gate-${route}-${stamp}`,
    title: "builder acceptance gate",
    body:
      `Create the file ${GATE_SURFACE} containing exactly this one line and nothing else:\n\n` +
      `${GATE_CONTENT}\n\n` +
      `This is an acceptance probe: the only acceptance is that the file exists with that content. ` +
      `Make the edit with your tools, then stop.`,
    surface: GATE_SURFACE,
  };
  const branch = dispatchBranch(issue);

  let signals: GateSignals = { changed: false, fileExists: false, typechecks: false, wroteViaTool: null, costUsd: 0, timedOut: false };
  let buildSessionId: string | undefined;

  try {
    const result = await runBuildLeg(issue, config, { model });
    buildSessionId = result.buildSessionId;
    signals.changed = result.changed;
    signals.costUsd = estimateCost(result.route, result.tokens.input, result.tokens.output);
    if (result.changed) {
      const { fileExists, typechecks } = await verifyBranch(config.repoPath, branch);
      signals.fileExists = fileExists;
      signals.typechecks = typechecks;
      signals.wroteViaTool = await inspectToolCalls(config.repoPath, result.buildSessionId);
    }
  } catch (err) {
    if (err instanceof AgentTimeoutError) signals.timedOut = true;
    else {
      console.error(`GATE ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    // No residue (assertion 5): drop the pushed gate branch (local + remote) and any worktree.
    await removeWorktree(config.repoPath, join(config.repoPath, ".worktrees", `build-${issue.id.toLowerCase()}`));
    await $`git -C ${config.repoPath} branch -D ${branch}`.nothrow().quiet();
    await $`git -C ${config.repoPath} push origin --delete ${branch}`.nothrow().quiet();
    if (buildSessionId) {
      const serve = await startServe(config.repoPath);
      try {
        await new OpencodeClient(serve.baseUrl).deleteSession(buildSessionId);
      } catch {
        /* best-effort */
      } finally {
        serve.stop();
      }
    }
  }

  const verdict = evaluateGate(signals);
  const date = new Date().toISOString().slice(0, 10);
  console.log(
    `\nbuilder-acceptance gate — route=${route}\n` +
      `  1 diff(changed):   ${signals.changed}\n` +
      `  2 file exists:     ${signals.fileExists}\n` +
      `  2 typechecks:      ${signals.typechecks}\n` +
      `  3 write tool call: ${signals.wroteViaTool === null ? "n/a (deferred to #1)" : signals.wroteViaTool}\n` +
      `  4 cost:            $${signals.costUsd.toFixed(4)} (ceil $${COST_CEIL_USD.toFixed(2)})\n` +
      `  4 timed out:       ${signals.timedOut}`,
  );
  if (verdict.pass) {
    console.log(`\nGATE PASS ${route} ${date}`);
  } else {
    console.error(`\nGATE FAIL ${route} ${date}\n${verdict.failures.map((f) => `  - assertion ${f}`).join("\n")}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const route = process.argv[2] ?? "builder";
  await runGate(route);
}
