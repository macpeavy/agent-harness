# LiteLLM spend ledger callback (ADR 0026, AGENT-41) — the real cost of every call.
#
# OpenCode can't see custom-provider spend, and LiteLLM's own persistent spend store needs
# Postgres (its Prisma schema hardcodes `provider = "postgresql"`). But the *number* doesn't
# need that store: LiteLLM computes the real cost of every successful call and hands it to a
# CustomLogger as `response_cost`. This callback appends one JSONL line per call to a ledger
# the substrate reads (src/dispatch/litellm-spend.ts) — making LiteLLM the system of record for
# cost (ADR 0002/0026) without standing up a database. It replaces the substrate's prior
# token-count estimation as the source of recorded per-route spend.
#
# Wired in via `litellm_settings: callbacks: ["litellm_spend_logger.spend_logger_instance"]`
# in litellm.yaml — the proxy resolves the dotted path relative to the config file's directory
# (this file sits next to litellm.yaml) and grabs the named instance.
#
# Fail-open: a ledger write must NEVER break a model call. Every hook is wrapped; on any error
# we swallow it (a missed cost line is a measurement gap, not an outage).

import json
import os
import threading
from typing import Any, Optional

from litellm.integrations.custom_logger import CustomLogger

# Repo root is two levels up from this file (config/litellm_spend_logger.py → repo root), so the
# ledger path is stable regardless of the gateway's cwd. AH_SPEND_LEDGER overrides (the TS reader
# honours the same env + default).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_LEDGER = os.path.join(_REPO_ROOT, ".substrate", "litellm-spend.jsonl")


def _ledger_path() -> str:
    return os.environ.get("AH_SPEND_LEDGER", _DEFAULT_LEDGER)


class SpendLogger(CustomLogger):
    """Appends each successful call's real cost (and the route it was billed under) to the
    JSONL spend ledger. One line per call; append-only; never blocks the call path."""

    def __init__(self) -> None:
        super().__init__()
        # Serialise appends from concurrent in-flight calls so two lines never interleave.
        self._lock = threading.Lock()

    # The proxy fires the async hook for LiteLLM-native async flows and the sync hook otherwise;
    # wire both to the same writer so we capture every call regardless of path.
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:
        self._record(kwargs, start_time, end_time)

    def log_success_event(self, kwargs, response_obj, start_time, end_time) -> None:
        self._record(kwargs, start_time, end_time)

    def _record(self, kwargs: dict, start_time: Any, end_time: Any) -> None:
        try:
            line = self._build_line(kwargs, start_time, end_time)
            if line is None:
                return
            path = _ledger_path()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            blob = json.dumps(line, separators=(",", ":"))
            with self._lock:
                with open(path, "a", encoding="utf-8") as fh:
                    fh.write(blob + "\n")
        except Exception:
            # Fail-open: cost logging must never break a call. A dropped line is a gap, not an error.
            pass

    def _build_line(self, kwargs: dict, start_time: Any, end_time: Any) -> Optional[dict]:
        # The StandardLoggingPayload carries LiteLLM's own computed cost + the route (model_group)
        # + token counts; prefer it, fall back to top-level kwargs for resilience across versions.
        slp = kwargs.get("standard_logging_object") or {}

        cost = slp.get("response_cost")
        if cost is None:
            cost = kwargs.get("response_cost")
        if cost is None:
            return None  # nothing to record without a cost — skip rather than write a null

        # `model_group` is the route name from model_list (e.g. "chief", "reviewer", "builder") —
        # the key the substrate attributes spend by. It distinguishes routes that share an upstream
        # (chief/reviewer/builder-strong are all sonnet-4.6). Fall back to the metadata/model.
        route = slp.get("model_group")
        if not route:
            meta = kwargs.get("litellm_params", {}).get("metadata", {}) or {}
            route = meta.get("model_group")
        if not route:
            route = slp.get("model") or kwargs.get("model")

        return {
            "tsStart": _epoch_ms(start_time, slp.get("startTime")),
            "tsEnd": _epoch_ms(end_time, slp.get("endTime")),
            "route": route,
            "model": slp.get("model") or kwargs.get("model"),
            "promptTokens": slp.get("prompt_tokens") or 0,
            "completionTokens": slp.get("completion_tokens") or 0,
            "totalTokens": slp.get("total_tokens") or 0,
            "costUsd": float(cost),
            "callId": slp.get("id") or kwargs.get("litellm_call_id"),
        }


def _epoch_ms(dt: Any, fallback_epoch_s: Any) -> Optional[int]:
    """Wall-clock epoch milliseconds. start_time/end_time arrive as datetimes; the SLP carries
    epoch seconds as a fallback. Same host clock as the substrate's Date.now(), so the windows
    line up for attribution."""
    try:
        if dt is not None and hasattr(dt, "timestamp"):
            return int(dt.timestamp() * 1000)
        if fallback_epoch_s is not None:
            return int(float(fallback_epoch_s) * 1000)
    except Exception:
        pass
    return None


# The instance the proxy imports (the dotted path in litellm.yaml ends in this name).
spend_logger_instance = SpendLogger()
