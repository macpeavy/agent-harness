// The history CLI — render a complete feature timeline from the substrate DB:
// feature/session/chunk/dispatch graph → FeatureHistory → terminal string.
// Pure assembly + render sit in history-assemble.ts and history-render.ts;
// this entry wires the repo, loads the graph, assembles, renders, and prints.
//
// Run: bun run src/cli/history.ts <featureId> (or `make history FEATURE=<id>`; needs env)

import { PlanRepository } from "../substrate/plan";
import { assembleHistory } from "./history-assemble";
import { renderHistory } from "./history-render";

if (import.meta.main) {
  const featureId = process.argv[2];
  if (!featureId) {
    console.error("usage: bun run src/cli/history.ts <featureId>");
    process.exit(1);
  }

  const dbPath = process.env.SUBSTRATE_DB ?? ".substrate/substrate.db";
  const plan = new PlanRepository(dbPath, { migrate: false });

  try {
    const graph = plan.loadFeatureGraph(featureId);
    if (!graph) {
      console.error(`no feature ${featureId}`);
      process.exit(1);
    }
    console.log(renderHistory(assembleHistory(graph)));
  } finally {
    plan.close();
  }
}
