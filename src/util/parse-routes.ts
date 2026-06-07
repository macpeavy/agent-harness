// Parse a comma-separated route CSV into trimmed, non-empty route names.
//
// Falls back to the three spike routes (builder, builder-alt, reviewer) when
// the input is undefined. Throws if the result is empty after parsing.

const DEFAULT_ROUTES = "builder, builder-alt, reviewer";

export function parseRoutes(input?: string): string[] {
  const raw = input ?? DEFAULT_ROUTES;
  const routes = raw.split(",").map((s) => s.trim()).filter(Boolean);

  if (routes.length === 0) {
    throw new Error(`parseRoutes: no routes parsed from "${raw}"`);
  }

  return routes;
}
