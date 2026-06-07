// AGENT-17 — builder-model tool-calling probe.
//
// For each candidate builder agent (config/litellm.yaml route + opencode.json agent),
// run the write-a-file test through OpenCode: dispatch the builder persona on that model
// with a task that REQUIRES the Write tool, then check whether the file was actually
// created. A model that tool-calls writes the file (PASS); one that emits tool calls as
// text leaves no file (FAIL) — the qwen failure mode this screens for (ADR 0010).
//
// Prereqs: the LiteLLM gateway up (config/litellm.yaml routes) + env; the candidate
// routes/agents present in config + opencode.json.
//
// Run:  bun run src/probe-builder.ts

import { $ } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./opencode/agent-runner";

// Candidate agent → live OpenRouter price ($/M in, $/M out), 2026-06-07. The active
// builder set: the primary (Mistral Small 4) + the two validated Western alternates.
// Add a route in config/litellm.yaml + opencode.json to probe a new candidate.
const CANDIDATES: { agent: string; inPerM: number; outPerM: number }[] = [
  { agent: "builder", inPerM: 0.15, outPerM: 0.6 }, // Mistral Small 4 (the pick)
  { agent: "builder-nano", inPerM: 0.1, outPerM: 0.4 },
  { agent: "builder-gemini", inPerM: 0.1, outPerM: 0.4 },
];

const MARKER = "TOOL_CALL_OK";

interface ProbeResult {
  agent: string;
  pass: boolean;
  fileContent: string;
  tokens: { input: number; output: number };
  costUsd: number;
  reply: string;
}

async function probe(workspace: string, c: (typeof CANDIDATES)[number]): Promise<ProbeResult> {
  // A multi-step build: a util + its co-located test — three sequential Write calls
  // (the third-call failure mode the research flags for the Mistral lineage). Tools
  // must execute, not text-emit; we don't ask it to run the test (no deps in scratch).
  const dir = `probe-${c.agent}`;
  const prompt =
    `In the current working directory, create exactly three files. Use your file-writing ` +
    `tool for each; do not run git and do not run any tests.\n` +
    `1. ${dir}/add.ts — export a function \`add(a: number, b: number): number\` returning a + b.\n` +
    `2. ${dir}/add.test.ts — a bun:test that imports add and asserts add(2, 3) === 5.\n` +
    `3. ${dir}/${MARKER}.txt — containing the single line ${MARKER}.\n` +
    `Stop once all three files exist.`;

  const run = await runAgent(workspace, { agent: c.agent, prompt, mode: "sync", title: `probe ${c.agent}` });
  const files = [`${dir}/add.ts`, `${dir}/add.test.ts`, `${dir}/${MARKER}.txt`];
  const present = files.filter((f) => existsSync(join(workspace, f)));
  const pass = present.length === files.length;
  const fileContent = `${present.length}/${files.length} files written: ${present.join(", ")}`;
  const costUsd = (run.tokens.input * c.inPerM + run.tokens.output * c.outPerM) / 1_000_000;

  return { agent: c.agent, pass, fileContent, tokens: run.tokens, costUsd, reply: run.reply };
}

async function main(): Promise<void> {
  // Isolated workspace carrying the project config so OpenCode loads the candidate agents.
  const repo = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), "ah-probe-"));
  await $`cp ${repo}/opencode.json ${workspace}/opencode.json`.quiet();
  await $`cp -r ${repo}/agents ${workspace}/agents`.quiet();

  const results: ProbeResult[] = [];
  try {
    for (const c of CANDIDATES) {
      console.log(`\n── probing ${c.agent} ──`);
      try {
        const r = await probe(workspace, c);
        results.push(r);
        console.log(`  ${r.pass ? "PASS ✓ wrote the file" : "FAIL ✗ no file (text-emitted tool call?)"}`);
        console.log(`  tokens ${r.tokens.input}in/${r.tokens.output}out  cost $${r.costUsd.toFixed(5)}`);
        console.log(`  file: ${r.fileContent.slice(0, 80)}`);
        console.log(`  reply: ${r.reply.slice(0, 280).replace(/\s+/g, " ")}`);
      } catch (err) {
        console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  console.log(`\n══ summary (baseline: DeepSeek ~$0.005/build) ══`);
  for (const r of results) {
    console.log(
      `  ${r.agent.padEnd(18)} ${r.pass ? "PASS" : "FAIL"}  $${r.costUsd.toFixed(5)}  (${r.tokens.input}in/${r.tokens.output}out)`,
    );
  }
}

main();
