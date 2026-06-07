// drizzle-kit config — generates the dispatch context's migrations from the schema
// source of truth (src/substrate/dispatch/schema.ts) into ./drizzle (committed;
// migrations are source, applied at repository startup). Run: bun run db:generate.
// ADR 0016.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/substrate/dispatch/schema.ts",
  out: "./drizzle",
});
