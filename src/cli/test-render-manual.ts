import { renderHistory } from "./history-render";
import type { FeatureHistory } from "./history-assemble";

const history: FeatureHistory = {
  feature: {
    id: "fhv-render",
    title: "Pure render layer: given a FeatureHistory",
    description: "test",
    state: "done",
    budgetUsd: null,
    createdAt: 1000,
    updatedAt: 1000,
  },
  sessions: [
    {
      session: {
        id: "session-1",
        featureId: "fhv-render",
        branch: "session-main",
        prNumber: 42,
        prUrl: "https://github.com/test/pr/42",
        locEstimate: 250,
        state: "done",
        lastError: null,
        budgetExceededUsd: null,
        createdAt: 1000,
        updatedAt: 1000,
      },
      chunks: [
        {
          chunk: {
            id: "chunk-render",
            sessionId: "session-1",
            surface: "src/cli/history-render.ts",
            intent: "Pure render layer implementation",
            contract: "export function renderHistory(history: FeatureHistory): string",
            acceptance: "tests pass",
            dataShapes: "FeatureHistory",
            preResolved: "Local trunc helper, no ANSI",
            outOfScope: "No DB or I/O",
            tierHint: "cheap",
            state: "done",
            dispatchId: "dispatch-1",
            createdAt: 1000,
            updatedAt: 1000,
          },
          dependsOn: [],
          dispatch: null,
          events: [
            {
              kind: "build",
              timestampMs: 1000,
              costUsd: 0.05,
              escalationKind: null,
              escalationReason: null,
            },
            {
              kind: "review",
              timestampMs: 2000,
              costUsd: 0.03,
              escalationKind: null,
              escalationReason: null,
            },
            {
              kind: "done",
              timestampMs: 3000,
              costUsd: 0,
              escalationKind: null,
              escalationReason: null,
            },
          ],
        },
      ],
      totalCostUsd: 0.08,
      escalations: [],
    },
  ],
  totalCostUsd: 0.08,
  totalEscalations: 0,
  chiefCostNote: "dispatch-legs only",
};

const output = renderHistory(history);
console.log(output);
console.log("\n--- Line length verification ---");
const lines = output.split("\n");
let allGood = true;
lines.forEach((line, i) => {
  if (line.length > 100) {
    console.log(`Line ${i} exceeds 100 chars: length=${line.length}`);
    allGood = false;
  }
});
if (allGood) {
  console.log(`All ${lines.length} lines are ≤100 chars ✓`);
}
