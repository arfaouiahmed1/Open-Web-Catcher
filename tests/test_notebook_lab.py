from __future__ import annotations

import json
from pathlib import Path

from src.evaluation.notebook_lab import CSV_COLUMNS, load_case_rows, row_to_evaluation_case, summarize_results


def test_load_case_rows_normalizes_template_csv():
    rows = load_case_rows(Path("data/evals/classification_cases.csv"))

    assert len(rows) == 1
    assert set(CSV_COLUMNS).issubset(rows[0].keys())
    assert rows[0]["enabled"] is False
    assert rows[0]["tags"] == ["classification", "placeholder"]


def test_row_to_evaluation_case_builds_live_assertions():
    row = {
        "case_id": "hosting-001",
        "url": "https://example.com/watch",
        "notes": "test row",
        "tags": ["hosting", "critical"],
        "expected_page_type": "hosting_page",
        "expected_final_status": "success",
        "min_streams": "1",
        "required_tools": "open_url|capture_streams",
        "expected_provider_keywords": "cloudflare|cdn77",
        "requires_provider_analysis": "true",
    }

    case = row_to_evaluation_case(row, target="hosting", case_index=1)

    assert case.mode == "live"
    assert case.input["url"] == "https://example.com/watch"
    assert case.assertions["min_streams"] == 1
    assert case.assertions["required_tools"] == ["open_url", "capture_streams"]
    assert case.assertions["expected_provider_keywords"] == ["cloudflare", "cdn77"]
    assert case.assertions["requires_provider_analysis"] is True


def test_summarize_results_computes_aggregate_rates():
    summary = summarize_results(
        [
            {
                "evaluation_status": "passed",
                "hallucination_score": 1.0,
                "tool_accuracy_score": 0.8,
                "reliability_score": 0.9,
                "latency_ms": 100.0,
                "total_cost_usd": 0.12,
            },
            {
                "evaluation_status": "failed",
                "hallucination_score": 0.5,
                "tool_accuracy_score": 0.6,
                "reliability_score": 0.4,
                "latency_ms": 300.0,
                "total_cost_usd": 0.24,
                "failure_mode": "TimeoutError",
            },
        ]
    )

    assert summary["overall"]["total_cases"] == 2
    assert summary["overall"]["pass_rate"] == 0.5
    assert summary["overall"]["hallucination_rate"] == 0.25
    assert summary["failure_modes"]["TimeoutError"] == 1


def test_agent_evaluation_notebook_is_valid_json():
    notebook = json.loads(Path("notebooks/06_agent_evaluation_lab.ipynb").read_text(encoding="utf-8"))

    assert notebook["nbformat"] == 4
    assert notebook["cells"]
