import { renderStatus } from "./src/substrate/dispatch/status";

const d = [
  {
    id: "d1",
    issueId: "1",
    title: "Title",
    branch: "branch",
    spec: "spec",
    state: "queued",
    route: "builder",
    amendRounds: 0,
    buildCostUsd: 0.01,
    reviewCostUsd: 0.02,
    amendCostUsd: 0.03,
    buildSessionId: null,
    reviewSessionId: null,
    prUrl: null,
    escalated: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

console.log(renderStatus(d));
console.log("\n---\n");
console.log(renderStatus([]));
