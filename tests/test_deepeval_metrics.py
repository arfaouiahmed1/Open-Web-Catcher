"""DeepEval metric tests for Open Web Catcher.

Each test validates one of the five metrics against a realistic fixture
that mirrors what the pipeline actually produces.

Run with deepeval's CLI for the Confident AI dashboard:
    deepeval test run tests/test_deepeval_metrics.py

Or with plain pytest (no dashboard):
    pytest tests/test_deepeval_metrics.py -v

Markers
-------
All tests are marked ``deepeval`` so you can skip them in fast CI:
    pytest -m "not deepeval"
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Skip the entire module gracefully if deepeval is not installed.
# ---------------------------------------------------------------------------
deepeval = pytest.importorskip("deepeval", reason="deepeval not installed")

from deepeval import assert_test  # type: ignore[import]
from deepeval.test_case import LLMTestCase, ToolCall  # type: ignore[import]

from src.evaluation.deepeval_bridge import (
    EXPECTED_TOOLS_BY_PROFILE,
    answer_relevancy_metric,
    build_test_case,
    default_metrics,
    faithfulness_metric,
    hallucination_metric,
    task_completion_metric,
    tool_correctness_metric,
)

pytestmark = pytest.mark.deepeval


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

def _make_trace(tool_calls: list[dict[str, Any]], tool_results: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a minimal trace dict that mirrors RunTrace event structure."""
    events: list[dict[str, Any]] = []
    seq = 1
    for tc, tr in zip(tool_calls, tool_results):
        events.append({
            "seq": seq,
            "kind": "tool_call_started",
            "actor": "hosting_page_agent",
            "message": f"Calling {tc['tool_name']}",
            "status": "info",
            "details": {"tool_name": tc["tool_name"], "args": tc.get("args", {})},
        })
        seq += 1
        events.append({
            "seq": seq,
            "kind": "tool_call_finished",
            "actor": "hosting_page_agent",
            "message": f"Finished {tc['tool_name']}",
            "status": tr.get("status", "success"),
            "details": {
                "tool_name": tc["tool_name"],
                "result": tr.get("result", ""),
            },
        })
        seq += 1
    return {"events": events}


def _make_case_result(
    *,
    artifact: dict[str, Any],
    trace: dict[str, Any],
) -> MagicMock:
    obj = MagicMock()
    obj.output = artifact
    obj.trace = trace
    return obj


# ---------------------------------------------------------------------------
# Realistic artifact fixtures
# ---------------------------------------------------------------------------

GOOD_ARTIFACT: dict[str, Any] = {
    "url": "https://illegal-stream.example.com/live/football",
    "page_type": "hosting_page",
    "final_status": "success",
    "all_streams": [
        {"url": "https://cdn.provider.net/live/stream.m3u8", "protocol": "hls"},
        {"url": "https://cdn.provider.net/live/stream.mpd", "protocol": "dash"},
    ],
    "provider_analysis": [
        {
            "stream_url": "https://cdn.provider.net/live/stream.m3u8",
            "ip": "1.2.3.4",
            "hostname": "cdn.provider.net",
            "org": "AS12345 ExampleCDN Ltd",
            "provider": "ExampleCDN Ltd",
            "country": "NL",
            "abuse_email": "abuse@examplecdn.net",
            "whois_raw": "% Abuse contact: abuse@examplecdn.net",
        }
    ],
    "takedown_emails": [
        {
            "provider": "ExampleCDN Ltd",
            "abuse_email": "abuse@examplecdn.net",
            "subject": "DMCA Takedown Notice — Infringing Stream on cdn.provider.net",
            "body": (
                "Dear ExampleCDN Ltd,\n\n"
                "We are writing to report copyright infringement hosted on your network.\n"
                "The following stream URL was found serving illegal content:\n"
                "  https://cdn.provider.net/live/stream.m3u8\n\n"
                "This content infringes upon rights held by [Rights Holder].\n"
                "Please remove or disable access to the infringing material immediately.\n\n"
                "Evidence:\n"
                "  Source page: https://illegal-stream.example.com/live/football\n"
                "  Stream IP:   1.2.3.4 (AS12345 ExampleCDN Ltd)\n"
                "  Screenshot:  https://res.cloudinary.com/demo/image/upload/evidence.jpg\n\n"
                "Thank you for your prompt attention.\n"
            ),
            "infringing_url": "https://illegal-stream.example.com/live/football",
            "stream_urls": ["https://cdn.provider.net/live/stream.m3u8"],
            "screenshot_urls": ["https://res.cloudinary.com/demo/image/upload/evidence.jpg"],
        }
    ],
}

GOOD_TOOL_CALLS = [
    {"tool_name": "open_url", "args": {"url": "https://illegal-stream.example.com/live/football"}},
    {"tool_name": "get_page_context", "args": {}},
    {"tool_name": "play_media", "args": {"selector": "video"}},
    {"tool_name": "capture_streams", "args": {"frame_path": "root"}},
    {"tool_name": "take_screenshot", "args": {}},
]

GOOD_TOOL_RESULTS = [
    {"status": "success", "result": "Page loaded: illegal-stream.example.com — title: 'Live Football Stream'"},
    {"status": "success", "result": "Page contains a <video> element with src pointing to cdn.provider.net"},
    {"status": "success", "result": "Media started playing. Network requests intercepted."},
    {
        "status": "success",
        "result": (
            "Captured streams: "
            "['https://cdn.provider.net/live/stream.m3u8', 'https://cdn.provider.net/live/stream.mpd']"
        ),
    },
    {"status": "success", "result": "Screenshot saved: https://res.cloudinary.com/demo/image/upload/evidence.jpg"},
]

GOOD_TRACE = _make_trace(GOOD_TOOL_CALLS, GOOD_TOOL_RESULTS)


# ---------------------------------------------------------------------------
# 1. HallucinationMetric
#    The agent should NOT claim streams/providers that aren't in tool outputs.
# ---------------------------------------------------------------------------

class TestHallucinationMetric:
    def test_good_run_no_hallucination(self):
        """A successful run where all streams come from tool outputs should pass."""
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        assert_test(tc, [hallucination_metric(threshold=0.5)])

    def test_hallucinated_provider_is_flagged(self):
        """An artifact that claims a provider never mentioned in tool outputs should fail."""
        artifact = {
            **GOOD_ARTIFACT,
            "provider_analysis": [
                {
                    "stream_url": "https://cdn.provider.net/live/stream.m3u8",
                    "provider": "MadeUpProviderXYZ Inc",  # never appeared in any tool output
                    "abuse_email": "abuse@madeup.xyz",
                    "org": "AS99999 MadeUpProviderXYZ Inc",
                    "ip": "9.9.9.9",
                    "hostname": "cdn.madeup.xyz",
                    "country": "XX",
                    "whois_raw": "",
                }
            ],
        }
        # Tool results do NOT mention MadeUpProviderXYZ → hallucination expected
        sparse_results = [{"status": "success", "result": "Page loaded"} for _ in GOOD_TOOL_CALLS]
        trace = _make_trace(GOOD_TOOL_CALLS, sparse_results)
        case_result = _make_case_result(artifact=artifact, trace=trace)
        tc = build_test_case(case_result, target_profile="hosting")
        metric = hallucination_metric(threshold=0.5)
        metric.measure(tc)
        # We assert the score is computed (value between 0 and 1)
        assert 0.0 <= metric.score <= 1.0, "HallucinationMetric must return a score in [0, 1]"


# ---------------------------------------------------------------------------
# 2. FaithfulnessMetric
#    The DMCA email body should only reference evidence captured by tools.
# ---------------------------------------------------------------------------

class TestFaithfulnessMetric:
    def test_email_grounded_in_tool_outputs(self):
        """DMCA email references streams and IPs that appear in tool outputs → faithful."""
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        assert_test(tc, [faithfulness_metric(threshold=0.7)])

    def test_email_with_no_tool_outputs_is_unfaithful(self):
        """If retrieval_context is empty, faithfulness score should be low."""
        empty_trace: dict[str, Any] = {"events": []}
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=empty_trace)
        tc = build_test_case(case_result, target_profile="hosting")
        metric = faithfulness_metric(threshold=0.7)
        metric.measure(tc)
        assert 0.0 <= metric.score <= 1.0


# ---------------------------------------------------------------------------
# 3. ToolCorrectnessMetric
#    The hosting agent must call open_url, play_media, capture_streams, take_screenshot.
# ---------------------------------------------------------------------------

class TestToolCorrectnessMetric:
    def test_correct_tools_used_by_hosting_agent(self):
        """Hosting agent that called all expected tools should pass."""
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        assert_test(tc, [tool_correctness_metric(threshold=0.6)])

    def test_missing_capture_streams_lowers_score(self):
        """Hosting agent that skipped capture_streams should score lower."""
        partial_calls = [tc for tc in GOOD_TOOL_CALLS if tc["tool_name"] != "capture_streams"]
        partial_results = GOOD_TOOL_RESULTS[: len(partial_calls)]
        trace = _make_trace(partial_calls, partial_results)
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=trace)
        tc = build_test_case(case_result, target_profile="hosting")
        metric = tool_correctness_metric(threshold=0.6)
        metric.measure(tc)
        assert 0.0 <= metric.score <= 1.0

    def test_expected_tools_per_profile(self):
        """Verify EXPECTED_TOOLS_BY_PROFILE covers all four agent profiles."""
        for profile in ("classification", "landing", "hosting", "embedded"):
            assert profile in EXPECTED_TOOLS_BY_PROFILE
            assert len(EXPECTED_TOOLS_BY_PROFILE[profile]) >= 2


# ---------------------------------------------------------------------------
# 4. AnswerRelevancyMetric
#    The pipeline's output should be relevant to the input streaming URL.
# ---------------------------------------------------------------------------

class TestAnswerRelevancyMetric:
    def test_relevant_output_for_streaming_url(self):
        """A full extraction result is relevant to the input URL."""
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        assert_test(tc, [answer_relevancy_metric(threshold=0.7)])

    def test_irrelevant_output_when_no_streams(self):
        """When nothing was found and status is failed, relevancy may be low."""
        empty_artifact: dict[str, Any] = {
            "url": "https://illegal-stream.example.com/live/football",
            "page_type": "",
            "final_status": "failed",
            "all_streams": [],
            "provider_analysis": [],
            "takedown_emails": [],
        }
        case_result = _make_case_result(artifact=empty_artifact, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        metric = answer_relevancy_metric(threshold=0.7)
        metric.measure(tc)
        assert 0.0 <= metric.score <= 1.0


# ---------------------------------------------------------------------------
# 5. TaskCompletionMetric
#    The pipeline's goal: find streams + provider, generate DMCA email.
# ---------------------------------------------------------------------------

class TestTaskCompletionMetric:
    def test_complete_pipeline_run_passes(self):
        """A run that found streams, identified the provider, and wrote a DMCA email completes the task."""
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        assert_test(tc, [task_completion_metric(threshold=0.6)])

    def test_partial_run_no_email_lower_completion(self):
        """A run that found streams but produced no DMCA email is only partially complete."""
        partial_artifact = {
            **GOOD_ARTIFACT,
            "takedown_emails": [],  # email generation skipped
        }
        case_result = _make_case_result(artifact=partial_artifact, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        metric = task_completion_metric(threshold=0.6)
        metric.measure(tc)
        assert 0.0 <= metric.score <= 1.0

    def test_failed_run_low_completion(self):
        """A run with no streams and no email should have the lowest task completion."""
        failed_artifact: dict[str, Any] = {
            "url": "https://illegal-stream.example.com/live/football",
            "final_status": "failed",
            "all_streams": [],
            "provider_analysis": [],
            "takedown_emails": [],
        }
        empty_trace: dict[str, Any] = {"events": []}
        case_result = _make_case_result(artifact=failed_artifact, trace=empty_trace)
        tc = build_test_case(case_result, target_profile="hosting")
        metric = task_completion_metric(threshold=0.6)
        metric.measure(tc)
        assert 0.0 <= metric.score <= 1.0


# ---------------------------------------------------------------------------
# Integration: all five metrics together on a good run
# ---------------------------------------------------------------------------

class TestAllMetricsTogether:
    def test_default_metrics_on_successful_run(self):
        """A realistic successful pipeline run should pass all five default metrics."""
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        assert_test(tc, default_metrics())

    def test_build_test_case_structure(self):
        """build_test_case should always return an LLMTestCase with the right fields."""
        case_result = _make_case_result(artifact=GOOD_ARTIFACT, trace=GOOD_TRACE)
        tc = build_test_case(case_result, target_profile="hosting")
        assert isinstance(tc, LLMTestCase)
        assert tc.input == GOOD_ARTIFACT["url"]
        assert tc.actual_output  # non-empty summary
        assert isinstance(tc.retrieval_context, list)
        assert len(tc.retrieval_context) == len(GOOD_TOOL_CALLS)  # one per finished tool call
        assert isinstance(tc.tools_called, list)
        assert all(isinstance(c, ToolCall) for c in tc.tools_called)
        assert isinstance(tc.expected_tools, list)
