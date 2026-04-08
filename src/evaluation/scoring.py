"""Rule-based evaluation helpers for hallucination and tool reliability."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from src.models.schemas import EvaluationAssertionResult, EvaluationCase, EvaluationCaseResult


def _collect_streams(artifact: dict[str, Any]) -> list[str]:
    streams: list[str] = []
    for entry in artifact.get("all_streams", []) or artifact.get("streams", []):
        if isinstance(entry, dict) and entry.get("url"):
            streams.append(str(entry["url"]))
    for entry in artifact.get("streaming_urls", []) or artifact.get("all_stream_urls", []):
        if isinstance(entry, dict) and entry.get("url"):
            streams.append(str(entry["url"]))
    for server in artifact.get("servers", []):
        if not isinstance(server, dict):
            continue
        streams.extend(str(url) for url in server.get("m3u8_urls", []) if url)
        streams.extend(str(url) for url in server.get("mpd_urls", []) if url)
        streams.extend(str(url) for url in server.get("mp4_urls", []) if url)
    return streams


def _tool_names(trace: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for event in trace.get("events", []):
        details = event.get("details", {}) if isinstance(event, dict) else {}
        tool_name = str(details.get("tool_name", "") or "").strip()
        if tool_name and event.get("kind") == "tool_call_started":
            names.append(tool_name)
    return names


def _tool_error_count(trace: dict[str, Any]) -> int:
    count = 0
    for event in trace.get("events", []):
        if event.get("kind") == "tool_call_finished" and str(event.get("status", "")).lower() == "error":
            count += 1
    return count


def _collect_hosting_page_urls(artifact: dict[str, Any]) -> list[str]:
    hosting_pages = artifact.get("hosting_pages", [])
    if not hosting_pages and isinstance(artifact.get("metadata"), dict):
        hosting_pages = artifact["metadata"].get("hosting_pages", [])
    urls: list[str] = []
    for item in hosting_pages or []:
        if isinstance(item, dict) and item.get("url"):
            urls.append(str(item["url"]))
        elif isinstance(item, str) and item:
            urls.append(item)
    return urls


def _collect_embedded_urls(artifact: dict[str, Any]) -> list[str]:
    urls: list[str] = [str(item) for item in artifact.get("embedded_urls", []) if item]
    metadata = artifact.get("metadata")
    if isinstance(metadata, dict):
        for server in metadata.get("servers", []) or []:
            if isinstance(server, dict) and server.get("embedded_url"):
                urls.append(str(server["embedded_url"]))
    return urls


def _provider_strings(artifact: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for entry in artifact.get("provider_analysis", []) or []:
        if not isinstance(entry, dict):
            continue
        for key in ("provider", "org", "hostname", "abuse_email"):
            value = str(entry.get(key, "") or "").strip()
            if value:
                values.append(value.lower())
    return values


def _stream_host_strings(streams: list[str]) -> list[str]:
    hosts: list[str] = []
    for stream_url in streams:
        host = (urlparse(stream_url).netloc or "").strip().lower()
        if host:
            hosts.append(host)
    return hosts


def _artifact_failure_text(artifact: dict[str, Any]) -> str:
    values = [
        artifact.get("failure_mode"),
        artifact.get("error_message"),
        artifact.get("status"),
        artifact.get("final_status"),
    ]
    metadata = artifact.get("metadata")
    if isinstance(metadata, dict):
        values.extend([metadata.get("decision"), metadata.get("error"), metadata.get("down_reason")])
    return " ".join(str(value).strip().lower() for value in values if value)


def _confidence_text(artifact: dict[str, Any]) -> str:
    value = artifact.get("confidence", "")
    if not value and isinstance(artifact.get("classification"), dict):
        value = artifact["classification"].get("confidence", "")
    return str(value or "").strip().lower()


def _confidence_rank(value: str) -> int:
    if value == "high":
        return 3
    if value == "medium":
        return 2
    if value == "low":
        return 1
    return 0


def _matches_keywords(corpus: list[str], keywords: list[str]) -> bool:
    haystack = " ".join(corpus)
    return all(keyword.lower() in haystack for keyword in keywords)


def evaluate_case_artifact(
    case: EvaluationCase,
    *,
    artifact: dict[str, Any],
    trace: dict[str, Any],
    latency_ms: float = 0.0,
    total_cost_usd: float = 0.0,
) -> EvaluationCaseResult:
    assertions = case.assertions or {}
    tool_names = _tool_names(trace)
    tool_error_count = _tool_error_count(trace)
    streams = _collect_streams(artifact)
    hosting_page_urls = _collect_hosting_page_urls(artifact)
    embedded_urls = _collect_embedded_urls(artifact)
    final_status = str(artifact.get("final_status") or artifact.get("status") or "").strip()
    page_type = str(
        artifact.get("page_type")
        or ((artifact.get("classification") or {}).get("page_type") if isinstance(artifact.get("classification"), dict) else "")
        or ""
    ).strip()

    assertion_results: list[EvaluationAssertionResult] = []

    def check(name: str, passed: bool, expected: Any = None, actual: Any = None, message: str = "") -> None:
        assertion_results.append(
            EvaluationAssertionResult(
                name=name,
                passed=passed,
                expected=expected,
                actual=actual,
                message=message,
            )
        )

    expected_status = assertions.get("expected_final_status")
    if expected_status is not None:
        check(
            "expected_final_status",
            final_status == expected_status,
            expected_status,
            final_status,
            "Final status should match the expected workflow outcome.",
        )

    expected_page_type = assertions.get("expected_page_type")
    if expected_page_type is not None:
        check(
            "expected_page_type",
            page_type == expected_page_type,
            expected_page_type,
            page_type,
            "Detected page type should match the expected page type.",
        )

    min_streams = assertions.get("min_streams")
    if min_streams is not None:
        check(
            "min_streams",
            len(streams) >= int(min_streams),
            min_streams,
            len(streams),
            "Enough stream URLs should be recovered.",
        )

    max_streams = assertions.get("max_streams")
    if max_streams is not None:
        check(
            "max_streams",
            len(streams) <= int(max_streams),
            max_streams,
            len(streams),
            "Recovered stream URLs should stay within the expected ceiling.",
        )

    min_hosting_pages = assertions.get("min_hosting_pages")
    if min_hosting_pages is not None:
        check(
            "min_hosting_pages",
            len(hosting_page_urls) >= int(min_hosting_pages),
            min_hosting_pages,
            len(hosting_page_urls),
            "Landing-page extraction should return enough hosting URLs.",
        )

    min_embedded_urls = assertions.get("min_embedded_urls")
    if min_embedded_urls is not None:
        check(
            "min_embedded_urls",
            len(embedded_urls) >= int(min_embedded_urls),
            min_embedded_urls,
            len(embedded_urls),
            "Embedded handoff URLs should be present when expected.",
        )

    required_tools = [str(item) for item in assertions.get("required_tools", [])]
    for tool_name in required_tools:
        check(
            f"required_tool:{tool_name}",
            tool_name in tool_names,
            True,
            tool_name in tool_names,
            "Required tool should appear in the trace.",
        )

    forbidden_tools = [str(item) for item in assertions.get("forbidden_tools", [])]
    for tool_name in forbidden_tools:
        check(
            f"forbidden_tool:{tool_name}",
            tool_name not in tool_names,
            False,
            tool_name in tool_names,
            "Forbidden tool should not appear in the trace.",
        )

    max_tool_errors = assertions.get("max_tool_errors")
    if max_tool_errors is not None:
        check(
            "max_tool_errors",
            tool_error_count <= int(max_tool_errors),
            max_tool_errors,
            tool_error_count,
            "Tool error count should stay within the allowed budget.",
        )

    if assertions.get("requires_provider_analysis"):
        actual = len(artifact.get("provider_analysis", []))
        check(
            "requires_provider_analysis",
            actual > 0,
            ">0",
            actual,
            "Provider analysis should be present.",
        )

    if assertions.get("requires_email_targets"):
        actual = len(artifact.get("takedown_emails", []))
        check(
            "requires_email_targets",
            actual > 0,
            ">0",
            actual,
            "At least one takedown email should be generated.",
        )

    provider_keywords = [str(item).strip() for item in assertions.get("expected_provider_keywords", []) if str(item).strip()]
    if provider_keywords:
        provider_corpus = _provider_strings(artifact)
        check(
            "expected_provider_keywords",
            _matches_keywords(provider_corpus, provider_keywords),
            provider_keywords,
            provider_corpus,
            "Provider analysis should contain the expected provider keywords.",
        )

    stream_host_keywords = [str(item).strip() for item in assertions.get("expected_stream_host_keywords", []) if str(item).strip()]
    if stream_host_keywords:
        stream_hosts = _stream_host_strings(streams)
        check(
            "expected_stream_host_keywords",
            _matches_keywords(stream_hosts, stream_host_keywords),
            stream_host_keywords,
            stream_hosts,
            "Recovered stream hosts should match the expected host keywords.",
        )

    hosting_url_keywords = [str(item).strip() for item in assertions.get("expected_hosting_url_keywords", []) if str(item).strip()]
    if hosting_url_keywords:
        check(
            "expected_hosting_url_keywords",
            _matches_keywords([url.lower() for url in hosting_page_urls], hosting_url_keywords),
            hosting_url_keywords,
            hosting_page_urls,
            "Returned hosting page URLs should include the expected keywords.",
        )

    embedded_url_keywords = [str(item).strip() for item in assertions.get("expected_embedded_url_keywords", []) if str(item).strip()]
    if embedded_url_keywords:
        check(
            "expected_embedded_url_keywords",
            _matches_keywords([url.lower() for url in embedded_urls], embedded_url_keywords),
            embedded_url_keywords,
            embedded_urls,
            "Returned embedded URLs should include the expected keywords.",
        )

    expected_failure_mode = str(assertions.get("expected_failure_mode", "") or "").strip()
    if expected_failure_mode:
        actual_failure_text = _artifact_failure_text(artifact)
        check(
            "expected_failure_mode",
            expected_failure_mode.lower() in actual_failure_text,
            expected_failure_mode,
            actual_failure_text,
            "Failure output should include the expected failure marker.",
        )

    confidence_at_least = str(assertions.get("confidence_at_least", "") or "").strip().lower()
    if confidence_at_least:
        actual_confidence = _confidence_text(artifact)
        check(
            "confidence_at_least",
            _confidence_rank(actual_confidence) >= _confidence_rank(confidence_at_least),
            confidence_at_least,
            actual_confidence,
            "Confidence should meet the configured minimum level.",
        )

    # Hallucination score: penalize unsupported claims even without explicit expectations.
    hallucination_score = 1.0
    if final_status == "success" and not streams:
        hallucination_score -= 0.5
    if artifact.get("provider_analysis") and not streams:
        hallucination_score -= 0.25
    if artifact.get("takedown_emails") and not artifact.get("provider_analysis"):
        hallucination_score -= 0.25
    hallucination_score = max(round(hallucination_score, 4), 0.0)

    required_present_ratio = (
        sum(1 for tool_name in required_tools if tool_name in tool_names) / len(required_tools)
        if required_tools
        else 1.0
    )
    forbidden_absent_ratio = (
        sum(1 for tool_name in forbidden_tools if tool_name not in tool_names) / len(forbidden_tools)
        if forbidden_tools
        else 1.0
    )
    tool_accuracy_score = round((required_present_ratio + forbidden_absent_ratio) / 2.0, 4)
    reliability_score = round(max(1.0 - (tool_error_count / max(len(tool_names), 1)), 0.0), 4)

    passed = all(item.passed for item in assertion_results) if assertion_results else hallucination_score >= 0.75
    return EvaluationCaseResult(
        case_id=case.id,
        case_name=case.name,
        status="passed" if passed else "failed",
        target_type=case.target_type,
        latency_ms=latency_ms,
        total_cost_usd=total_cost_usd,
        hallucination_score=hallucination_score,
        tool_accuracy_score=tool_accuracy_score,
        reliability_score=reliability_score,
        assertion_results=assertion_results,
        output=artifact,
        trace=trace,
    )
