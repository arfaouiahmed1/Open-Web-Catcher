"""DeepEval integration bridge for Open Web Catcher.

Converts EvaluationCaseResult / PipelineResult objects into DeepEval
LLMTestCase instances and exposes ready-to-use metric factories for the
five metrics relevant to this pipeline:

    HallucinationMetric   – did the agent invent streams/providers?
    FaithfulnessMetric    – is the DMCA email grounded in tool outputs?
    ToolCorrectnessMetric – did the agent call the right tools?
    AnswerRelevancyMetric – is the final answer relevant to the input URL?
    TaskCompletionMetric  – did the pipeline complete its goal?

Judge model
-----------
All LLM-judge metrics use Google Gemini via ``GeminiJudge``.
Set these env vars before running judge-based tests:

    GOOGLE_API_KEY=...
    GEMINI_JUDGE_MODEL=gemini-2.5-flash   # optional default

Usage (pytest):
    from src.evaluation.deepeval_bridge import build_test_case, default_metrics
    from deepeval import assert_test

    def test_my_run():
        tc = build_test_case(case_result)
        assert_test(tc, default_metrics())

Usage (bulk evaluate):
    from deepeval import evaluate
    results = evaluate(test_cases, default_metrics())
"""

from __future__ import annotations

import os
from typing import Any

# ---------------------------------------------------------------------------
# Lazy imports so the module can be imported without deepeval installed in
# production (it is a dev dependency only).
# ---------------------------------------------------------------------------


def _require_deepeval() -> None:
    try:
        import deepeval  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "deepeval is required for evaluation metrics. Install it with: pip install deepeval"
        ) from exc


# ---------------------------------------------------------------------------
# Gemini judge model
# ---------------------------------------------------------------------------


def _make_gemini_judge() -> Any:
    """Return a DeepEvalBaseLLM instance backed by Google Gemini."""
    _require_deepeval()
    try:
        from langchain_google_genai import ChatGoogleGenerativeAI
    except ImportError as exc:
        raise ImportError(
            "langchain-google-genai is required for the Gemini judge. "
            "Install project dependencies with: pip install -e ."
        ) from exc
    from deepeval.models.base_model import DeepEvalBaseLLM  # type: ignore[import]

    class GeminiJudge(DeepEvalBaseLLM):
        """Thin DeepEval wrapper around the project Gemini dependency."""

        def __init__(self) -> None:
            self.model_name = os.environ.get("GEMINI_JUDGE_MODEL", "gemini-2.5-flash")
            api_key = os.environ.get("GOOGLE_API_KEY", "").strip() or None
            self._client = ChatGoogleGenerativeAI(
                model=self.model_name,
                api_key=api_key,
                temperature=0,
                convert_system_message_to_human=True,
            )

        def get_model_name(self) -> str:
            return self.model_name

        def load_model(self) -> "GeminiJudge":
            return self

        def generate(self, prompt: str) -> str:
            response = self._client.invoke(prompt)
            content = getattr(response, "content", "")
            if isinstance(content, str):
                return content
            return str(content or "")

        async def a_generate(self, prompt: str) -> str:
            response = await self._client.ainvoke(prompt)
            content = getattr(response, "content", "")
            if isinstance(content, str):
                return content
            return str(content or "")

    return GeminiJudge()


# ---------------------------------------------------------------------------
# Internal helpers that extract data from the trace / artifact dicts
# ---------------------------------------------------------------------------


def _extract_tool_outputs(trace: dict[str, Any]) -> list[str]:
    """Return tool result strings from trace events (used as retrieval_context)."""
    outputs: list[str] = []
    for event in trace.get("events", []):
        if not isinstance(event, dict):
            continue
        if event.get("kind") != "tool_call_finished":
            continue
        details = event.get("details", {}) or {}
        tool_name = str(details.get("tool_name", "") or "").strip()
        result = details.get("result") or details.get("output") or details.get("content")
        if result is None:
            continue
        result_str = result if isinstance(result, str) else str(result)
        if tool_name:
            outputs.append(f"[{tool_name}] {result_str}")
        else:
            outputs.append(result_str)
    return outputs


def _extract_tool_calls_made(trace: dict[str, Any]) -> list[Any]:
    """Return DeepEval ToolCall objects for every tool_call_started event."""
    _require_deepeval()
    from deepeval.test_case import ToolCall  # type: ignore[import]

    calls: list[ToolCall] = []
    for event in trace.get("events", []):
        if not isinstance(event, dict):
            continue
        if event.get("kind") != "tool_call_started":
            continue
        details = event.get("details", {}) or {}
        tool_name = str(details.get("tool_name", "") or "").strip()
        if not tool_name:
            continue
        input_args: dict[str, Any] = {}
        raw_args = details.get("args") or details.get("input") or {}
        if isinstance(raw_args, dict):
            input_args = raw_args
        calls.append(ToolCall(name=tool_name, input_parameters=input_args))
    return calls


def _build_actual_output(artifact: dict[str, Any]) -> str:
    """Produce a human-readable summary of what the pipeline found.

    This is what the LLM judge evaluates as the 'answer'.
    """
    parts: list[str] = []

    page_type = str(
        artifact.get("page_type")
        or (artifact.get("classification") or {}).get("page_type", "")
        or ""
    ).strip()
    if page_type:
        parts.append(f"Page classified as: {page_type}")

    final_status = str(artifact.get("final_status") or artifact.get("status") or "").strip()
    if final_status:
        parts.append(f"Pipeline status: {final_status}")

    # Streams
    streams = _collect_stream_urls(artifact)
    if streams:
        parts.append(f"Streams found ({len(streams)}): " + ", ".join(streams[:5]))
    else:
        parts.append("No stream URLs found.")

    # Providers
    for entry in artifact.get("provider_analysis") or []:
        if not isinstance(entry, dict):
            continue
        provider = str(entry.get("provider") or "").strip()
        org = str(entry.get("org") or "").strip()
        abuse = str(entry.get("abuse_email") or "").strip()
        if provider or org:
            parts.append(f"Provider: {provider or org} — abuse contact: {abuse or 'n/a'}")

    # Takedown emails (body excerpt)
    for email in artifact.get("takedown_emails") or []:
        if not isinstance(email, dict):
            continue
        body = str(email.get("body") or "").strip()
        if body:
            parts.append(f"DMCA email body (excerpt): {body[:300]}")
            break  # one excerpt is enough for the judge

    return "\n".join(parts) if parts else "No output produced."


def _collect_stream_urls(artifact: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for entry in artifact.get("all_streams", []) or artifact.get("streams", []):
        if isinstance(entry, dict) and entry.get("url"):
            urls.append(str(entry["url"]))
    for entry in artifact.get("streaming_urls", []) or artifact.get("all_stream_urls", []):
        if isinstance(entry, dict) and entry.get("url"):
            urls.append(str(entry["url"]))
    for server in artifact.get("servers", []):
        if not isinstance(server, dict):
            continue
        urls.extend(str(u) for u in server.get("m3u8_urls", []) if u)
        urls.extend(str(u) for u in server.get("mpd_urls", []) if u)
        urls.extend(str(u) for u in server.get("mp4_urls", []) if u)
    return list(dict.fromkeys(urls))  # deduplicate, preserve order


# ---------------------------------------------------------------------------
# Expected tools per agent — used by ToolCorrectnessMetric
# ---------------------------------------------------------------------------

#: Canonical tool names each agent profile is expected to use.
EXPECTED_TOOLS_BY_PROFILE: dict[str, list[str]] = {
    "classification": ["open_url", "get_page_context"],
    "landing": ["open_url", "get_page_context", "click_element", "get_element_detail"],
    "hosting": ["open_url", "play_media", "capture_streams", "take_screenshot"],
    "embedded": ["open_url", "get_page_context", "play_media", "capture_streams"],
}

#: Default expected tools for a full pipeline run.
DEFAULT_EXPECTED_TOOLS: list[str] = [
    "open_url",
    "get_page_context",
    "capture_streams",
    "take_screenshot",
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_test_case(
    case_result: Any,
    *,
    target_profile: str = "",
    expected_tools: list[str] | None = None,
) -> Any:
    """Convert an EvaluationCaseResult into a DeepEval LLMTestCase.

    Args:
        case_result: An ``EvaluationCaseResult`` instance (or any object with
            ``.output`` and ``.trace`` dicts).
        target_profile: Optional agent profile name (``"classification"``,
            ``"landing"``, ``"hosting"``, ``"embedded"``).  When provided,
            ``expected_tools`` defaults to ``EXPECTED_TOOLS_BY_PROFILE[profile]``.
        expected_tools: Explicit list of tool names the agent should have used.
            Overrides ``target_profile`` lookup.

    Returns:
        A ``deepeval.test_case.LLMTestCase`` ready to pass to ``assert_test``
        or ``evaluate``.
    """
    _require_deepeval()
    from deepeval.test_case import LLMTestCase, ToolCall  # type: ignore[import]

    artifact: dict[str, Any] = getattr(case_result, "output", {}) or {}
    trace: dict[str, Any] = getattr(case_result, "trace", {}) or {}

    input_url = str(artifact.get("url") or (artifact.get("input") or {}).get("url", "") or "")

    actual_output = _build_actual_output(artifact)
    retrieval_context = _extract_tool_outputs(trace)
    tools_called = _extract_tool_calls_made(trace)

    # Resolve expected tools
    if expected_tools is not None:
        _expected_tools = [ToolCall(name=t, input_parameters={}) for t in expected_tools]
    elif target_profile and target_profile in EXPECTED_TOOLS_BY_PROFILE:
        _expected_tools = [
            ToolCall(name=t, input_parameters={}) for t in EXPECTED_TOOLS_BY_PROFILE[target_profile]
        ]
    else:
        _expected_tools = [ToolCall(name=t, input_parameters={}) for t in DEFAULT_EXPECTED_TOOLS]

    return LLMTestCase(
        input=input_url,
        actual_output=actual_output,
        retrieval_context=retrieval_context or ["No tool outputs captured."],
        tools_called=tools_called,
        expected_tools=_expected_tools,
    )


def build_test_case_from_pipeline_result(pipeline_result: Any) -> Any:
    """Convert a PipelineResult directly into a DeepEval LLMTestCase.

    Useful when you have the raw pipeline output without going through the
    EvaluationCase / scoring layer.
    """
    _require_deepeval()

    artifact = (
        pipeline_result.model_dump(mode="json") if hasattr(pipeline_result, "model_dump") else {}
    )

    # Flatten for _build_actual_output
    flat: dict[str, Any] = {
        "url": artifact.get("url", ""),
        "page_type": (artifact.get("classification") or {}).get("page_type", ""),
        "final_status": artifact.get("final_status", ""),
        "all_streams": artifact.get("all_streams", []),
        "provider_analysis": artifact.get("provider_analysis", []),
        "takedown_emails": artifact.get("takedown_emails", []),
    }

    # Build a synthetic trace from metrics.agents_invoked if no trace available
    trace: dict[str, Any] = {"events": []}

    class _FakeCaseResult:
        output = flat
        trace = {"events": []}

    return build_test_case(_FakeCaseResult())


# ---------------------------------------------------------------------------
# Metric factories
# ---------------------------------------------------------------------------


def hallucination_metric(threshold: float = 0.5) -> Any:
    """LLM judge: did the agent invent streams or providers not in tool outputs?"""
    _require_deepeval()
    from deepeval.metrics import HallucinationMetric  # type: ignore[import]

    return HallucinationMetric(threshold=threshold, model=_make_gemini_judge())


def faithfulness_metric(threshold: float = 0.7) -> Any:
    """LLM judge: is the DMCA email body grounded in captured tool evidence?"""
    _require_deepeval()
    from deepeval.metrics import FaithfulnessMetric  # type: ignore[import]

    return FaithfulnessMetric(threshold=threshold, model=_make_gemini_judge())


def tool_correctness_metric(threshold: float = 0.6) -> Any:
    """Checks that the agent used the expected tools for its profile.

    ToolCorrectnessMetric is deterministic (no LLM judge needed).
    """
    _require_deepeval()
    from deepeval.metrics import ToolCorrectnessMetric  # type: ignore[import]

    return ToolCorrectnessMetric(threshold=threshold)


def answer_relevancy_metric(threshold: float = 0.7) -> Any:
    """LLM judge: is the pipeline output relevant to the input streaming URL?"""
    _require_deepeval()
    from deepeval.metrics import AnswerRelevancyMetric  # type: ignore[import]

    return AnswerRelevancyMetric(threshold=threshold, model=_make_gemini_judge())


def task_completion_metric(threshold: float = 0.6) -> Any:
    """LLM judge: did the agent complete its goal (find stream + provider)?"""
    _require_deepeval()
    from deepeval.metrics import TaskCompletionMetric  # type: ignore[import]

    return TaskCompletionMetric(
        task="Extract streaming URLs and provider details from the given illegal streaming website URL, then generate a DMCA takedown email.",
        threshold=threshold,
        model=_make_gemini_judge(),
    )


def default_metrics(
    *,
    hallucination_threshold: float = 0.5,
    faithfulness_threshold: float = 0.7,
    tool_correctness_threshold: float = 0.6,
    answer_relevancy_threshold: float = 0.7,
    task_completion_threshold: float = 0.6,
) -> list[Any]:
    """Return all five metrics with configurable thresholds."""
    return [
        hallucination_metric(hallucination_threshold),
        faithfulness_metric(faithfulness_threshold),
        tool_correctness_metric(tool_correctness_threshold),
        answer_relevancy_metric(answer_relevancy_threshold),
        task_completion_metric(task_completion_threshold),
    ]
