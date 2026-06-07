// AGENT-26 — measurement shakedown harness.
//
// Hand-decomposed chunk specs (research/2026-06-07-shakedown/specs/) are enqueued as
// dispatches and driven through the P1 loop on the real builder (Mistral Small 4), one
// at a time, with per-chunk wall-time and the registry instrument read out at the end.
// First integrated end-to-end run of the spine on the real builder — watch for spine
// bugs, not just model behavior.
//
// Run:  bun run src/shakedown.ts   (gateway up with builder=Mistral + reviewer; env sourced)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { DispatchDaemon, dispatchBranch } from "./dispatch/daemon";
import { DispatchRepository, type DispatchState } from "./substrate/dispatch";

const SPEC_DIR = "research/2026-06-07-shakedown/specs";

const CHUNKS = [
  { id: "SHAKE-1", title: "cheap-able-fraction readout", spec: "chunk-1-readout.md" },
  { id: "SHAKE-2", title: "display format helpers", spec: "chunk-2-format.md" },
  { id: "SHAKE-3", title: "harness status renderer", spec: "chunk-3-status.md" },
];

const TERMINAL: DispatchState[] = ["done", "escalated", "failed"];
const legCost = (d: { buildCostUsd: number | null; reviewCostUsd: number | null; amendCostUsd: number | null }) =>
  (d.buildCostUsd ?? 0) + (d.reviewCostUsd ?? 0) + (d.amendCostUsd ?? 0);

async function main(): Promise<void> {
  const config = await loadConfig();
  const repo = new DispatchRepository();
  const daemon = new DispatchDaemon(repo, config);
  const wallMs: Record<string, number> = {};

  for (const chunk of CHUNKS) {
    const spec = readFileSync(join(SPEC_DIR, chunk.spec), "utf8");
    const issue = { id: chunk.id, title: chunk.title, body: spec };
    repo.create({ id: chunk.id, issueId: chunk.id, title: chunk.title, branch: dispatchBranch(issue), spec });

    console.log(`\n▶ driving ${chunk.id} — ${chunk.title}`);
    const t0 = Date.now();
    await daemon.runOnce();
    wallMs[chunk.id] = Date.now() - t0;

    const d = repo.get(chunk.id);
    if (!d) continue;
    console.log(
      `  ${d.state.toUpperCase()}  route=${d.route ?? "-"}  amends=${d.amendRounds}` +
        `  escalated=${d.escalated ?? "-"}  pr=${d.prUrl ?? "-"}`,
    );
    console.log(
      `  cost build=$${(d.buildCostUsd ?? 0).toFixed(5)} review=$${(d.reviewCostUsd ?? 0).toFixed(5)}` +
        ` amend=$${(d.amendCostUsd ?? 0).toFixed(5)} total=$${legCost(d).toFixed(5)}` +
        `  wall=${Math.round((wallMs[chunk.id] ?? 0) / 1000)}s`,
    );
  }

  const all = repo.list();
  const terminal = all.filter((d) => TERMINAL.includes(d.state));
  const done = all.filter((d) => d.state === "done");
  const totalCost = all.reduce((sum, d) => sum + legCost(d), 0);

  console.log(`\n══ aggregate (baseline: DeepSeek-era ~$0.09/PR) ══`);
  console.log(
    `  cheap-able fraction: ${done.length}/${terminal.length} = ` +
      `${terminal.length ? (done.length / terminal.length).toFixed(2) : "—"}`,
  );
  console.log(
    `  blended cost / ready PR: $${done.length ? (totalCost / done.length).toFixed(4) : "—"}` +
      `  (total spend $${totalCost.toFixed(4)})`,
  );
  repo.close();
}

main();
