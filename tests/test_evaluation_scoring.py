from __future__ import annotations

from src.evaluation.scoring import evaluate_case_artifact
from src.models.schemas import EvaluationCase


def test_evaluation_scoring_flags_hallucinated_success_without_streams():
    case = EvaluationCase(
        id=1,
        name="hallucination-check",
        target_type="workflow",
        assertions={"expected_final_status": "success", "min_streams": 1},
    )

    result = evaluate_case_artifact(
        case,
        artifact={"final_status": "success", "provider_analysis": [{"provider": "Example"}]},
        trace={"events": []},
    )

    assert result.status == "failed"
    assert result.hallucination_score == 0.25


def test_evaluation_scoring_measures_tool_accuracy_and_reliability():
    case = EvaluationCase(
        id=2,
        name="tool-discipline",
        target_type="tool",
        assertions={
            "required_tools": ["open_url", "capture_streams"],
            "forbidden_tools": ["delete_data"],
            "max_tool_errors": 1,
        },
    )

    result = evaluate_case_artifact(
        case,
        artifact={"result": {"ok": True}},
        trace={
            "events": [
                {"kind": "tool_call_started", "details": {"tool_name": "open_url"}},
                {"kind": "tool_call_started", "details": {"tool_name": "capture_streams"}},
                {"kind": "tool_call_finished", "status": "error", "details": {"tool_name": "capture_streams"}},
                {"kind": "tool_call_started", "details": {"tool_name": "capture_streams"}},
                {"kind": "tool_call_finished", "status": "success", "details": {"tool_name": "capture_streams"}},
            ]
        },
    )

    assert result.status == "passed"
    assert result.tool_accuracy_score == 1.0
    assert result.reliability_score == 0.6667


def test_evaluation_scoring_supports_provider_and_failure_expectations():
    case = EvaluationCase(
        id=3,
        name="provider-check",
        target_type="workflow",
        assertions={
            "expected_provider_keywords": ["cloudflare"],
            "expected_stream_host_keywords": ["cdn.example.com"],
            "expected_failure_mode": "timeout",
            "confidence_at_least": "medium",
            "min_hosting_pages": 1,
            "min_embedded_urls": 1,
        },
    )

    result = evaluate_case_artifact(
        case,
        artifact={
            "page_type": "hosting_page",
            "confidence": "high",
            "status": "failed",
            "error_message": "player timeout while loading stream",
            "streams": [{"url": "https://cdn.example.com/master.m3u8"}],
            "metadata": {
                "hosting_pages": [{"url": "https://site.example/watch/1"}],
                "servers": [{"embedded_url": "https://embed.example.com/abc"}],
            },
            "provider_analysis": [{"provider": "Cloudflare", "org": "AS13335 Cloudflare, Inc."}],
        },
        trace={"events": []},
    )

    assert result.status == "passed"
