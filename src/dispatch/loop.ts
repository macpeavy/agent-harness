// AGENT-9 / gate G3 — the make-or-break.
//
// Runs one real issue through the FULL loop — dispatch → build → PR → wake →
// review — then measures cost-per-PR and prints the verdict. The thesis holds if
// (a) the cheap builder produced a PR a human would merge (judged on the PR +
// review) and (b) cost-per-PR clears the budget (≈ $250 / ~90 PRs ≈ $2.80).

import { runBuildLeg, type Issue } from "./build-leg";
import { runReviewLeg } from "./review-leg";
import { estimateCost } from "./cost";

const TARGET_PER_PR = Number(process.env.TARGET_PER_PR ?? "2.80"); // $250 / ~90 PRs/mo

const ISSUE: Issue = {
  id: "G3-1",
  title: "Add a parseRoutes config helper with tests",
  body:
    "Add `src/util/parse-routes.ts` exporting `parseRoutes(input?: string): string[]`. " +
    "It splits a comma-separated string into trimmed, non-empty route names; throws a " +
    "clear Error if the result is empty; and when `input` is undefined falls back to the " +
    "three spike routes ['builder', 'builder-alt', 'reviewer']. Keep it typed and documented. " +
    "Add `src/util/parse-routes.test.ts` using `bun:test` covering: a normal CSV, surrounding " +
    "whitespace, the undefined-default case, and the empty/whitespace-only throw. Run `bun test` " +
    "and make sure it passes.",
};

async function main() {
  console.log(`AGENT-9 / G3 — full loop on ${ISSUE.id}: ${ISSUE.title}\n`);

  const build = await runBuildLeg(ISSUE);
  if (!build.changed || !build.prUrl) {
    console.log(`✗ builder produced no change — G3 FAIL (build leg)`);
    process.exit(1);
  }
  const prNumber = Number(build.prUrl.split("/").pop());
  console.log(`✓ build → ${build.prUrl}  [${build.route}: ${build.tokens.input}in/${build.tokens.output}out tok]`);

  const review = await runReviewLeg({ pr: prNumber, branch: build.branch });
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
