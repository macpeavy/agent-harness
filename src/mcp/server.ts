// The substrate MCP server (the router entrypoint, ADR 0017/0019). Exposes the substrate
// planning surface — `status` and `dispatch` (decompose lands with the chief) — as MCP
// tools an OpenCode agent (the chief, ADR 0012) loads over stdio. The tool logic lives in
// ./tools; this wires the service to the transport.
//
// Run (OpenCode launches it per opencode.json `mcp.substrate`):  bun run src/mcp/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PlanRepository } from "../substrate/plan";
import { DispatchRepository } from "../substrate/dispatch";
import { PlanDispatchService } from "../dispatch/plan-dispatch";
import { loadConfig } from "../config";
import { DEFAULT_DECOMPOSITION, loadDecompositionConfig, type DecompositionConfig } from "../decomposition-config";
import { DEFAULT_BUDGET, loadBudgetConfig, type BudgetConfig } from "../budget-config";
import { chunkGuidance, sessionGuidance } from "../dispatch/decompose-context";
import { runReadPrReviewLeg } from "../dispatch/legs/pr-review";
import {
  runStatus,
  runDispatch,
  runEstimate,
  runRaiseBudget,
  runDecompose,
  runBuildDirect,
  runMetaDecompose,
  runPromote,
  runRedecompose,
  runAddChunk,
  runAddSession,
  runAddEdge,
  runReviseChunk,
  runRemoveChunk,
  runRemoveSession,
  runRemoveEdge,
  runAddressReview,
  runCloseSession,
  type PrReviewReader,
} from "./tools";

// The chunk spec the chief authors per chunk (ADR 0014). The parent sessionId is omitted —
// the handler stamps it from the session, so the chief doesn't repeat it per chunk.
const chunkSpec = z.object({
  id: z.string().describe("unique chunk id (becomes the dispatch/branch id)"),
  surface: z.string().describe("the one file this chunk produces"),
  intent: z.string().describe("one sentence: what this chunk is for"),
  contract: z.string().describe("the exact signatures/types/exports it must produce"),
  acceptance: z.string().describe("acceptance criteria, including a test file"),
  dataShapes: z.string().optional().describe("data shapes the chunk works with"),
  preResolved: z.string().optional().describe("design decisions pre-resolved to avoid amends"),
  outOfScope: z.string().optional().describe("what this chunk must NOT do"),
  tierHint: z.enum(["cheap", "strong"]).optional().describe("build tier (default cheap)"),
});

/** Construction options — `readPrReview` reads a session PR's review off GitHub for
 *  `address_review` (the real impl is the PR-review leg bound to config; a test passes a fake;
 *  absent → the tool returns a configuration error). */
export interface SubstrateServerOptions {
  readPrReview?: PrReviewReader;
  /** The soft size dials (ADR 0022) surfaced into the decompose tool descriptions the chief
   *  reads. Defaults to the seed values; the main block loads config/decomposition.yaml. */
  decomposition?: DecompositionConfig;
  /** The budget dials (ADR 0026 decision 2) — feed the estimate + budget = estimate × headroom.
   *  Defaults to the seed values; the main block loads config/budget.yaml. */
  budget?: BudgetConfig;
}

/**
 * Build the substrate MCP server over a given service — pure construction, so a test can
 * link it to an in-memory client without spawning a process.
 */
export function createSubstrateServer(service: PlanDispatchService, opts: SubstrateServerOptions = {}): McpServer {
  const decomposition = opts.decomposition ?? DEFAULT_DECOMPOSITION;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const server = new McpServer({ name: "substrate", version: "0.1.0" });

  server.registerTool(
    "meta_decompose",
    {
      title: "Meta-decompose a feature into sessions",
      description:
        "Pass 1 of two-level decomposition (ADR 0020): write the feature + its SESSION " +
        "boundaries to the plan — no chunks yet. Each session is a reviewable unit that gets " +
        "one session-main PR. Then decompose each session (the `decompose` tool) into its " +
        `chunk-DAG.\n\n${sessionGuidance(decomposition)}`,
      inputSchema: {
        feature: z
          .object({
            id: z.string().describe("unique feature id"),
            title: z.string().describe("short feature title"),
            description: z.string().describe("the owner's intent"),
          })
          .describe("the feature being decomposed"),
        sessions: z
          .array(
            z.object({
              id: z.string().describe("unique session id (becomes the session-main branch id)"),
              locEstimate: z.number().optional().describe("the chief's session size target (see sessionTargetLines)"),
            }),
          )
          .describe("the session boundaries (one for a small feature, several for a large one)"),
      },
    },
    async (input) => runMetaDecompose(service, input),
  );

  server.registerTool(
    "decompose",
    {
      title: "Decompose a session into its chunk-DAG",
      description:
        "Pass 2 of two-level decomposition (ADR 0020): the INITIAL fill of a session — write its " +
        "chunks (each a full ADR 0014 spec) + dependency edges (`to` depends on `from`). The " +
        "session must already exist (from meta_decompose). To add ONE chunk to a session later " +
        "(during revision), use `add_chunk`, not this. Validated for cycles/unknown refs. " +
        `Plan-only — nothing dispatches until the owner approves.\n\n${chunkGuidance(decomposition)}`,
      inputSchema: {
        sessionId: z.string().describe("the session to decompose (from meta_decompose)"),
        chunks: z.array(chunkSpec).describe("the chunks of this session"),
        edges: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .describe("dependency edges — `to` depends on `from`"),
      },
    },
    async (input) => runDecompose(service, input),
  );

  server.registerTool(
    "build_direct",
    {
      title: "Build a small feature direct — no decomposition",
      description:
        "The small-feature path (ADR 0026): write the feature as ONE session + ONE chunk, no " +
        "chunk-DAG, NO decomposition pass — for a feature that one-shots (roughly one chunk's " +
        `worth, ~${decomposition.chunkTargetLines} lines / one or a few files). One builder + one ` +
        "review. Use this INSTEAD of meta_decompose + decompose when the feature is small enough " +
        "that a decomposition pass wouldn't amortize — decomposition only pays across enough " +
        "chunks (the $15-on-200-LOC bug was decomposing a tiny feature). The chunk's tier defaults " +
        "to cheap (Haiku); set tierHint 'strong' ONLY if genuinely gnarly — 'build direct' means " +
        "skip decomposition, NOT build on the strong model. Plan-only: this does NOT approve — " +
        "present the plan, say you're building direct, and call dispatch only on the owner's go.",
      inputSchema: {
        feature: z
          .object({
            id: z.string().describe("unique feature id"),
            title: z.string().describe("short feature title"),
            description: z.string().describe("the owner's intent"),
          })
          .describe("the small feature being built direct"),
        sessionId: z.string().describe("unique session id (becomes the session-main branch id)"),
        locEstimate: z.number().optional().describe("the feature's size estimate (see sessionTargetLines)"),
        chunk: chunkSpec.describe("the single chunk = the whole feature (a full ADR 0014 spec; tierHint defaults cheap)"),
      },
    },
    async (input) => runBuildDirect(service, input),
  );

  // --- planning-amendable: add + revise + prune (ADR 0020 §5b) — edit the plan before approval ---

  server.registerTool(
    "add_chunk",
    {
      title: "Add a chunk to a session",
      description:
        "Add ONE chunk to an existing session before approval (ADR 0020) — the incremental add " +
        "during revision (use `decompose` for the initial fill of an empty session). Optional " +
        "edges wire it to the session's existing chunks. Validated for cycles/unknown refs. " +
        "Allowed while the feature is in planning; frozen once approved.",
      inputSchema: {
        sessionId: z.string().describe("the session to add the chunk to"),
        chunk: chunkSpec.describe("the chunk to add (a full ADR 0014 spec)"),
        edges: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .optional()
          .describe("optional edges wiring the new chunk to the session's chunks (`to` depends on `from`)"),
      },
    },
    async (input) => runAddChunk(service, input),
  );

  server.registerTool(
    "add_session",
    {
      title: "Add a session to a feature",
      description:
        "Add ONE session to an existing feature before approval (ADR 0020 §5b) — the symmetric " +
        "counterpart to `remove_session`, for when the plan needs another reviewable unit " +
        "(use `meta_decompose` for the initial set). Decompose it afterward into its chunk-DAG. " +
        `Allowed while the feature is in planning; frozen once approved.\n\n${sessionGuidance(decomposition)}`,
      inputSchema: {
        featureId: z.string().describe("the feature to add the session to"),
        sessionId: z.string().describe("unique session id (becomes the session-main branch id)"),
        locEstimate: z.number().optional().describe("the chief's session size target (see sessionTargetLines)"),
      },
    },
    async (input) => runAddSession(service, input),
  );

  server.registerTool(
    "add_edge",
    {
      title: "Add a dependency edge",
      description:
        "Add ONE dependency edge (`from`→`to`, `to` depends on `from`) between two chunks of the " +
        "same session before approval (ADR 0020 §5b) — the symmetric counterpart to `remove_edge`. " +
        "Rejects a self-edge, a cross-session edge, or one that would form a cycle. Allowed while " +
        "the feature is in planning.",
      inputSchema: {
        from: z.string().describe("the precursor chunk id"),
        to: z.string().describe("the dependent chunk id"),
      },
    },
    async ({ from, to }) => runAddEdge(service, from, to),
  );

  server.registerTool(
    "revise_chunk",
    {
      title: "Revise a planned chunk",
      description:
        "Re-spec a planned chunk before approval (ADR 0020) — change only the fields you pass " +
        "(e.g. just the contract). Allowed while the feature is in planning; frozen once approved.",
      inputSchema: {
        chunkId: z.string().describe("the chunk to revise"),
        surface: z.string().optional().describe("the one file this chunk produces"),
        intent: z.string().optional().describe("one sentence: what this chunk is for"),
        contract: z.string().optional().describe("the exact signatures/types/exports it must produce"),
        acceptance: z.string().optional().describe("acceptance criteria, including a test file"),
        dataShapes: z.string().optional().describe("data shapes the chunk works with"),
        preResolved: z.string().optional().describe("design decisions pre-resolved to avoid amends"),
        outOfScope: z.string().optional().describe("what this chunk must NOT do"),
        tierHint: z.enum(["cheap", "strong"]).optional().describe("build tier"),
      },
    },
    async (input) => runReviseChunk(service, input),
  );

  server.registerTool(
    "remove_chunk",
    {
      title: "Remove a planned chunk",
      description:
        "Drop a planned chunk (and any edges touching it) before approval (ADR 0020). Allowed " +
        "while the feature is in planning.",
      inputSchema: { chunkId: z.string().describe("the chunk to remove") },
    },
    async ({ chunkId }) => runRemoveChunk(service, chunkId),
  );

  server.registerTool(
    "remove_session",
    {
      title: "Remove a session",
      description:
        "Drop a session and its whole sub-plan (its chunks + edges) before approval (ADR 0020). " +
        "Allowed while the feature is in planning.",
      inputSchema: { sessionId: z.string().describe("the session to remove") },
    },
    async ({ sessionId }) => runRemoveSession(service, sessionId),
  );

  server.registerTool(
    "remove_edge",
    {
      title: "Remove a dependency edge",
      description: "Drop one dependency edge (`from`→`to`) before approval (ADR 0020). Allowed while planning.",
      inputSchema: {
        from: z.string().describe("the precursor chunk id"),
        to: z.string().describe("the dependent chunk id"),
      },
    },
    async ({ from, to }) => runRemoveEdge(service, from, to),
  );

  server.registerTool(
    "status",
    {
      title: "Feature status",
      description:
        "Read a feature's plan + dispatch status: each chunk's state and its dispatch's " +
        "state, the cheap-able-fraction readout, and the parked escalations to route.",
      inputSchema: { featureId: z.string().describe("the feature id to report on") },
    },
    async ({ featureId }) => runStatus(service, featureId),
  );

  server.registerTool(
    "dispatch",
    {
      title: "Dispatch (approve) a session for build",
      description:
        "Approve the feature for build (ADR 0020) — calling this IS the act of approval (the " +
        "feature moves planning→ready, approving the whole session plan). It also locks the " +
        "feature's budget to estimate × headroom (ADR 0026), so a runtime overspend parks (never " +
        "hard-kills) — present the `estimate` first so the owner approves with the number in view. " +
        "The session loop then opens session-main, launches the ready chunks, and builds them into " +
        "the one session PR; you hand off and step back (use status to watch). Call it ONLY on the " +
        "owner's explicit go, never on a passing 'looks good', a guess, or silence. The owner " +
        "approves the session PR on merge.",
      inputSchema: { sessionId: z.string().describe("a session of the feature to approve for build") },
    },
    async ({ sessionId }) => runDispatch(service, sessionId, budget),
  );

  server.registerTool(
    "estimate",
    {
      title: "Estimate a feature's build cost (the pre-flight gate forecast)",
      description:
        "The pre-flight cost forecast (ADR 0026 decision 2) — present it at the gate as '$X to " +
        "build, go?' so the owner approves with the number in view. It's chunk count × the REAL " +
        "historical per-leg averages the instrument records (config seeds at cold start) + the " +
        "chief's decomposition. A FORECAST for the decision, NOT recorded spend (recorded cost is " +
        "always the real ledger numbers). On dispatch the budget locks to this estimate × headroom.",
      inputSchema: { featureId: z.string().describe("the feature to forecast") },
    },
    async ({ featureId }) => runEstimate(service, featureId, budget),
  );

  server.registerTool(
    "raise_budget",
    {
      title: "Raise a budget-parked feature's budget and resume it",
      description:
        "Raise a feature's budget and resume it (ADR 0026 decision 2, the 'continue' choice) when " +
        "a runtime overspend has parked it. Clears the budget park and returns its sessions to " +
        "building; a session whose chunk independently failed stays parked for you to route. The " +
        "owner's other options at a budget park need no tool: merge the session PR to ship what's " +
        "already done (chunks merge into session-main as they land), or abandon the feature.",
      inputSchema: {
        featureId: z.string().describe("the budget-parked feature"),
        budgetUsd: z.number().positive().describe("the new (higher) budget ceiling in USD"),
      },
    },
    async ({ featureId, budgetUsd }) => runRaiseBudget(service, featureId, budgetUsd),
  );

  server.registerTool(
    "address_review",
    {
      title: "Address the owner's review of a session PR",
      description:
        "Pull the owner's review off the session PR and route it into the amend cycle (ADR 0020 " +
        "§5). Inline comments are matched to a chunk by file and reopen it to amend — the daemon " +
        "amends the fix back into session-main and the PR updates; you don't relay routine notes. " +
        "General/unroutable notes come back for YOUR judgment (re-decompose, design change). Call " +
        "it on the owner's go to address their review of a session in `review`.",
      inputSchema: { sessionId: z.string().describe("the session whose PR review to address (must be in review)") },
    },
    async ({ sessionId }) => runAddressReview(service, opts.readPrReview, sessionId),
  );

  server.registerTool(
    "close_session",
    {
      title: "Close a session on the owner's merge",
      description:
        "Record that the owner merged the session PR (ADR 0020 §6): the session moves " +
        "`review → done`, and the feature completes when its last session merges. The merge " +
        "itself is the owner's, on GitHub (the gate) — call this only after they've merged. " +
        "Usually you DON'T need it: the substrate polls each in-review session's PR and " +
        "auto-closes on merge (you'll be told). This is the manual fallback; calling it after " +
        "an auto-close is a harmless no-op.",
      inputSchema: { sessionId: z.string().describe("the session whose PR the owner merged") },
    },
    async ({ sessionId }) => runCloseSession(service, sessionId),
  );

  server.registerTool(
    "promote",
    {
      title: "Tier-promote an escalated chunk",
      description:
        "Resolve a parked escalated chunk by re-dispatching it on the STRONG build tier " +
        "(the builder on the strong route). Use when the chunk is sound but too hard for " +
        "the cheap tier — not when it needs splitting (use redecompose for that).",
      inputSchema: { chunkId: z.string().describe("the escalated chunk to promote + re-dispatch") },
    },
    async ({ chunkId }) => runPromote(service, chunkId),
  );

  server.registerTool(
    "redecompose",
    {
      title: "Re-decompose an escalated chunk",
      description:
        "Resolve a parked escalated chunk by retiring it and replacing it with smaller " +
        "chunks (it was too big). Provide the replacement chunk specs and the edges among " +
        "them — and edges reconnecting the retired chunk's former dependents to the new " +
        "ones. Validated for cycles. The replacements dispatch through the normal path.",
      inputSchema: {
        chunkId: z.string().describe("the escalated chunk to retire"),
        chunks: z.array(chunkSpec).describe("the replacement chunks (featureId is inferred)"),
        edges: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .describe("dependency edges — `to` depends on `from`; may reference surviving chunks"),
      },
    },
    async (input) => runRedecompose(service, input),
  );

  return server;
}

if (import.meta.main) {
  // SUBSTRATE_DB overrides the default shared-db path — lets a smoke test point the booted
  // subprocess at a temp db instead of the repo's real one. Both repos open the same file.
  const dbPath = process.env.SUBSTRATE_DB;
  const plan = dbPath ? new PlanRepository(dbPath) : new PlanRepository();
  const dispatch = dbPath ? new DispatchRepository(dbPath) : new DispatchRepository();
  const service = new PlanDispatchService(plan, dispatch);
  // The real PR-review reader, resolved lazily so booting (and the stdio smoke test) doesn't
  // require full gateway/gh config — only an actual address_review call loads it.
  const readPrReview: PrReviewReader = async (prNumber) => runReadPrReviewLeg(prNumber, await loadConfig());
  // Load the decomposition dials (ADR 0022) so the meta_decompose / decompose tool descriptions
  // the chief reads carry the configured soft targets — falls back to the seed defaults if absent.
  const server = createSubstrateServer(service, {
    readPrReview,
    decomposition: loadDecompositionConfig(),
    budget: loadBudgetConfig(),
  });
  await server.connect(new StdioServerTransport());
}
