"""ValidatorAgent: LLM-as-judge evidence gate before the provider stage.

Plan task 24 / [VAL-C1/C2][H3/H4][P1][U10][D14]:

- ``probe_reachability`` — MANDATORY HEAD/short-GET reachability probe via
  httpx (with timeout); a stream URL may not enter the evidence set until it
  has passed this probe.
- ``score_evidence`` — LLM-as-judge producing a typed ``JudgeVerdict`` scoring
  evidence sufficiency: streams reachable?, screenshots↔claims consistency,
  contract compliance.
- ``request_replan`` — bounded replan request (max 1 per stage).

The graph-side ``validate_evidence`` node lives in
``src.agents.orchestrator``; this module owns the agent logic so it can be
unit-tested in isolation with mocked verdicts and recorded HTTP transports.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import httpx
from langchain_core.messages import HumanMessage

from src.agents.runtime import build_llm, parse_json_object
from src.models.judge import (
    JudgeVerdict,
    ReachabilityProbe,
    ReplanRequest,
)
from src.utils.config import Settings

PROMPT_PATH = Path("configs/prompts/evidence_validation_v2.md")

#: Bounded replan budget per stage (plan D14): exactly one retry allowed.
MAX_REPLANS_PER_STAGE = 1

#: Defaults used when Settings does not define the optional validator knobs
#: (config.py is intentionally untouched by plan task 24).
DEFAULT_PROBE_TIMEOUT_SECONDS = 5.0
DEFAULT_EVIDENCE_THRESHOLD = 0.6
_SHORT_GET_MAX_BYTES = 1024


def _load_prompt() -> str:
    try:
        return PROMPT_PATH.read_text(encoding="utf-8")
    except OSError:
        return (
            "You are a strict evidence judge. Respond with exactly one JSON "
            'object with keys: verdict ("pass"|"replan"|"fail"), '
            "evidence_score (0..1), playback_confidence (0..1), channel_match "
            "(bool), reasoning (str), required_fixes (list), flagged_urls "
            "(list of suspected-hallucinated stream URLs)."
        )


class ValidatorAgent:
    """Evidence validator: mandatory probes + LLM-as-judge + bounded replan."""

    agent_id = "validator"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    # ── Reachability probe (mandatory pre-evidence gate) ─────────────────────

    def _probe_timeout(self) -> float:
        return float(
            getattr(self.settings, "validator_probe_timeout_seconds", DEFAULT_PROBE_TIMEOUT_SECONDS)
        )

    async def probe_reachability(
        self,
        urls: list[str],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> list[ReachabilityProbe]:
        """HEAD each URL (short-GET fallback) under a hard timeout.

        This probe is mandatory: callers must drop any URL whose probe says
        unreachable before the URL enters the evidence set (VAL-C2).
        """
        probes: list[ReachabilityProbe] = []
        if not urls:
            return probes
        async with httpx.AsyncClient(
            timeout=self._probe_timeout(),
            follow_redirects=True,
            transport=transport,
        ) as client:
            for url in urls:
                probes.append(await self._probe_one(client, url))
        return probes

    async def _probe_one(self, client: httpx.AsyncClient, url: str) -> ReachabilityProbe:
        started = time.perf_counter()
        method = "HEAD"
        try:
            response = await client.head(url)
            if response.status_code >= 400 or response.status_code < 200:
                # Some CDNs reject HEAD; fall back to a bounded short GET.
                method = "GET"
                request = client.build_request("GET", url)
                response = await client.send(request, stream=True)
                read = 0
                async for chunk in response.aiter_bytes(_SHORT_GET_MAX_BYTES):
                    read += len(chunk)
                    if read >= _SHORT_GET_MAX_BYTES:
                        break
                await response.aclose()
            latency_ms = (time.perf_counter() - started) * 1000.0
            reachable = 200 <= response.status_code < 400
            return ReachabilityProbe(
                url=url,
                reachable=reachable,
                status_code=response.status_code,
                method=method,
                latency_ms=round(latency_ms, 2),
                error="" if reachable else f"http_{response.status_code}",
            )
        except Exception as exc:  # noqa: BLE001 — a dead URL is data, not a crash
            latency_ms = (time.perf_counter() - started) * 1000.0
            return ReachabilityProbe(
                url=url,
                reachable=False,
                method=method,
                latency_ms=round(latency_ms, 2),
                error=f"{type(exc).__name__}: {exc}"[:300],
            )

    # ── LLM-as-judge scoring ─────────────────────────────────────────────────

    async def score_evidence(
        self,
        *,
        infringing_url: str,
        stream_records: list[dict[str, Any]],
        screenshot_count: int,
        probe_outcomes: dict[str, bool] | None = None,
        llm: Any = None,
    ) -> JudgeVerdict:
        """Judge the evidence inventory and return a typed ``JudgeVerdict``.

        ``llm`` is an injection seam for tests; production builds the shared
        LiteLLM-backed chat model. An unparseable judge answer yields a
        conservative fallback verdict instead of crashing the run.
        """
        probe_outcomes = probe_outcomes or {}
        stream_lines = [
            f"- {rec.get('url', '')} protocol={rec.get('protocol', '')} "
            f"channel={rec.get('channel_name', '')} "
            f"probe_reachable={probe_outcomes.get(rec.get('url', ''), 'n/a')}"
            for rec in stream_records
        ] or ["- (none)"]
        prompt = (
            f"{_load_prompt()}\n\n"
            f"Infringing source page: {infringing_url}\n"
            f"Screenshots captured: {screenshot_count}\n"
            "Candidate stream URLs (with probe outcome):\n" + "\n".join(stream_lines)
        )
        llm = llm or build_llm(
            settings=self.settings, temperature=0.0, agent_id=self.agent_id
        )
        try:
            message = await llm.ainvoke([HumanMessage(content=prompt)])
            raw_text = str(getattr(message, "content", message) or "")
        except Exception as exc:  # noqa: BLE001 — judge failure must not kill the run
            return self._fallback_verdict(reason=f"judge_llm_error: {type(exc).__name__}: {exc}")
        payload, _reason = parse_json_object(raw_text)
        if not payload:
            return self._fallback_verdict(reason=f"judge_output_unparseable: {_reason}")
        try:
            verdict = JudgeVerdict(**payload)
        except Exception as exc:  # noqa: BLE001 — schema drift → conservative fallback
            return self._fallback_verdict(reason=f"judge_schema_mismatch: {exc}")
        return verdict.model_copy(
            update={
                "flagged_urls": [u for u in verdict.flagged_urls if isinstance(u, str) and u],
            }
        )

    @staticmethod
    def _fallback_verdict(*, reason: str) -> JudgeVerdict:
        """Conservative default when the judge cannot be trusted."""
        return JudgeVerdict(
            verdict="replan",
            evidence_score=0.0,
            playback_confidence=0.0,
            channel_match=False,
            reasoning=reason[:300],
            required_fixes=["re-run evidence judging"],
            flagged_urls=[],
        )

    # ── Bounded replan ────────────────────────────────────────────────────────

    def request_replan(self, *, stage: str, reason: str, attempt: int) -> ReplanRequest | None:
        """Return a replan request while the per-stage budget lasts, else None.

        ``attempt`` counts replans already spent for ``stage``; with
        ``MAX_REPLANS_PER_STAGE = 1`` the second call returns None so the
        pipeline degrades gracefully instead of looping forever.
        """
        if attempt >= MAX_REPLANS_PER_STAGE:
            return None
        return ReplanRequest(stage=stage, reason=reason[:300], attempt=attempt + 1)
