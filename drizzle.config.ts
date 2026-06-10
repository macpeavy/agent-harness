// drizzle-kit config — generates the substrate's migrations from the schema sources
// (the dispatch + plan + runtime contexts) into ./drizzle (committed; migrations are
// source, applied at repository startup). One migration set over the shared substrate db,
// so the cross-context FK (chunks.dispatch_id → dispatches.id) is valid. Run:
// bun run db:generate. ADR 0016/0019.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/substrate/dispatch/schema.ts", "./src/substrate/plan/schema.ts", "./src/substrate/runtime/schema.ts"],
  out: "./drizzle",
});
