// AGENT-9 / gate G3 — the make-or-break.
//
// Runs one real issue through the FULL loop — dispatch → build → PR → wake →
// review — then measures cost-per-PR and prints the verdict. The thesis holds if
// (a) the cheap builder produced a PR a human would merge (judged on the PR +
// review) and (b) cost-per-PR clears the budget (≈ $250 / ~90 PRs ≈ $2.80).

import { runBuildLeg, type Issue } from "./build-leg";
import { runReviewLeg } from "./review-leg";
import { estimateCost } from "./cost";
import { loadConfig } from "../config";

const TARGET_PER_PR = Number(process.env.TARGET_PER_PR ?? "2.80"); // $250 / ~90 PRs/mo

const ISSUE: Issue = {
  id: "REG-1",
  title: "SQLite-backed dispatch registry",
  body:
    "Add a SQLite-backed dispatch registry for the substrate using Bun's built-in `bun:sqlite` " +
    "(no external deps, no server). New file `src/substrate/registry.ts`.\n\n" +
    "A *dispatch* is the substrate's unit of work (one issue through build -> review -> PR). It sits " +
    "ABOVE OpenCode's own session store, so this registry holds dispatch-level state and only LINKS " +
    "to OpenCode session ids — it must NOT duplicate session/message data.\n\n" +
    "Implement a `DispatchRegistry` class:\n" +
    "- constructor takes a db file path (default `.orchestrator/dispatches.db`); opens the db and " +
    "creates the schema if absent.\n" +
    "- schema `dispatches`: id TEXT PRIMARY KEY, issue_id TEXT, title TEXT, branch TEXT, state TEXT, " +
    "build_session_id TEXT NULL, review_session_id TEXT NULL, pr_url TEXT NULL, cost_usd REAL NULL, " +
    "created_at INTEGER, updated_at INTEGER.\n" +
    "- `create(rec)`: insert a new dispatch in state 'queued'.\n" +
    "- `get(id)`: record or null. `list(filter?)`: optional filter by state, newest first.\n" +
    "- `transition(id, toState)`: validate against the allowed graph (queued->building->review->done; " +
    "any non-terminal -> failed) and THROW on an illegal transition; update state + updated_at in a " +
    "transaction.\n" +
    "- `setSessions(id, {buildSessionId?, reviewSessionId?})`, `setPr(id, url)`, `setCost(id, usd)`: " +
    "link OpenCode session ids / PR / cost onto a dispatch.\n" +
    "- `resumeIncomplete()`: return all dispatches in non-terminal states (crash recovery).\n" +
    "Use prepared statements; wrap transition in a transaction.\n\n" +
    "Add `src/substrate/registry.test.ts` (`bun:test`) against a temp db file (clean up after): " +
    "create/get/list, a valid transition path, an illegal transition throwing, setSessions/setPr/setCost, " +
    "and resumeIncomplete returning only non-terminal records.\n\n" +
    "`bun test` and `bun run typecheck` must pass. Do not modify other files.",
};

async function main() {
  console.log(`AGENT-9 / G3 — full loop on ${ISSUE.id}: ${ISSUE.title}\n`);

  const config = await loadConfig();
  const build = await runBuildLeg(ISSUE, config);
  if (!build.changed || !build.prUrl) {
    console.log(`✗ builder produced no change — G3 FAIL (build leg)`);
    process.exit(1);
  }
  const prNumber = Number(build.prUrl.split("/").pop());
  console.log(`✓ build → ${build.prUrl}  [${build.route}: ${build.tokens.input}in/${build.tokens.output}out tok]`);

  const review = await runReviewLeg({ pr: prNumber, branch: build.branch }, config);
  console.log(`✓ review posted (idle after ${review.waitedMs}ms)  [${review.route}: ${review.tokens.input}in/${review.tokens.output}out tok]`);

  const buildCost = estimateCost(build.route, build.tokens.input, build.tokens.output);
  const reviewCost = estimateCost(review.route, review.tokens.input, review.tokens.output);
  const total = buildCost + reviewCost;

  console.log(`\n── cost-per-PR (estimated from tokens × current OpenRouter pricing) ──`);
  console.log(`  build  (${build.route})  $${buildCost.toFixed(4)}`);
  console.log(`  review (${review.route}) $${reviewCost.toFixed(4)}`);
  console.log(`  total                    $${total.toFixed(4)}   target ≤ $${TARGET_PER_PR.toFixed(2)}`);
  console.log(`\ncost verdict: ${total <= TARGET_PER_PR ? "WITHIN budget ✓" : "OVER budget ✗"}`);
  console.log(`mergeability: judge on ${build.prUrl} + the posted review (human/companion call).`);
}

main();
