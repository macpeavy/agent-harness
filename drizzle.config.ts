// drizzle-kit config — generates the dispatch registry's migrations from the schema
// source of truth (src/substrate/schema.ts) into ./drizzle (committed; migrations are
// source, applied at registry startup). Run: bun run db:generate. ADR 0016.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/substrate/schema.ts",
  out: "./drizzle",
});
