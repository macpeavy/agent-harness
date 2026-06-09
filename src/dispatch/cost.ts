// Per-route pricing ($ per million tokens), mirroring config/litellm.yaml.
//
// SCOPE (ADR 0026): this is NO LONGER the source of recorded cost. Recorded per-leg and
// per-feature spend now comes from REAL LiteLLM-computed numbers in the spend ledger
// (src/dispatch/litellm-spend.ts, fed by config/litellm_spend_logger.py). This estimate
// survives for ONE job: the builder-acceptance gate's pre-flight cost ceiling (gate-builder.ts),
// a backstop that runs without the daemon/ledger and only needs an order-of-magnitude guard.
// Source: OpenRouter catalog, 2026-06. Keep in sync with the gateway routes.

export const ROUTE_PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  builder: { inPerM: 1.0, outPerM: 5.0 }, // claude-haiku-4.5 (ADR 0025 step-up; flash-lite flaked under load)
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
