// Per-route pricing ($ per million tokens), mirroring config/litellm.yaml.
// OpenCode doesn't surface custom-provider cost, so we estimate from real token
// counts × current OpenRouter pricing. Source: OpenRouter catalog, 2026-06.
// Keep in sync with the gateway routes.

export const ROUTE_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  builder: { inPerM: 0.15, outPerM: 0.6 }, // Mistral Small 4 (mistral-small-2603) — AGENT-17 pick
  "builder-nano": { inPerM: 0.1, outPerM: 0.4 }, // gpt-4.1-nano (validated alternate)
  "builder-gemini": { inPerM: 0.1, outPerM: 0.4 }, // gemini-2.5-flash-lite (validated alternate)
  reviewer: { inPerM: 3.0, outPerM: 15.0 }, // claude-sonnet-4.6
};

/** Estimate USD cost for a session given its route and token counts. */
export function estimateCost(route: string, inputTokens: number, outputTokens: number): number {
  const p = ROUTE_PRICING[route];
  if (!p) return 0;
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}
