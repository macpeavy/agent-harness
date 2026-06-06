#!/usr/bin/env bash
# verify-gateway.sh — confirm the LiteLLM gateway is up and all three seats route.
#
# Prereqs: the gateway is running (see config/README.md) and OPENROUTER_API_KEY +
# LITELLM_MASTER_KEY are exported (e.g. `set -a; source .env; set +a`).
# Usage: ./scripts/verify-gateway.sh
set -uo pipefail

BASE="${LITELLM_BASE:-http://localhost:4000}"
KEY="${LITELLM_MASTER_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "LITELLM_MASTER_KEY not set — run: set -a; source .env; set +a" >&2
  exit 1
fi

echo "→ health: $BASE/health/liveliness"
if ! curl -fsS "$BASE/health/liveliness" >/dev/null; then
  echo "  gateway not reachable at $BASE — is it running?" >&2
  exit 1
fi
echo "  ok"

rc=0
for seat in builder builder-alt reviewer; do
  echo "→ route: $seat"
  resp="$(curl -fsS "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$seat\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}],\"max_tokens\":16}" 2>/dev/null)" || {
      echo "  request failed for $seat" >&2; rc=1; continue; }
  content="$(printf '%s' "$resp" | jq -r '.choices[0].message.content // .error.message // "(no content)"' 2>/dev/null)"
  echo "  ← $content"
done

echo "Done. Per-request cost is in the gateway logs (the AGENT-9 cost signal)."
exit $rc
