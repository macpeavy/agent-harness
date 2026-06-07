// Per-route pricing ($ per million tokens), mirroring config/litellm.yaml.
// OpenCode doesn't surface custom-provider cost, so we estimate from real token
// counts × current OpenRouter pricing. Source: OpenRouter catalog, 2026-06.
// Keep in sync with the gateway routes.

export const ROUTE_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  builder: { inPerM: 0.1, outPerM: 0.2 }, // deepseek-v4-flash
  "builder-alt": { inPerM: 0.07, outPerM: 0.27 }, // qwen3-coder-30b
  reviewer: { inPerM: 3.0, outPerM: 15.0 }, // claude-sonnet-4.6
};

/** Estimate USD cost for a session given its route and token counts. */
export function estimateCost(route: string, inputTokens: number, outputTokens: number): number {
  const p = ROUTE_PRICING[route];
  if (!p) return 0;
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}
