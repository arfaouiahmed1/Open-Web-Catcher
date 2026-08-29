"""Unit tests for cost math v2 (plan task 11, evidence COST-F1..F4).

Every dollar assertion below shows its hand-computed arithmetic inline.
All fixtures are pure dicts â€” no network, no database, no clocks.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from src.utils import provider_pricing
from src.utils.config import Settings
from src.utils.instrumentation import estimate_usage_cost, resolve_model_pricing
from src.utils.observability import (
    ObservabilityStatus,
    RunObserver,
    RunRegistry,
    get_model_pricing_for_settings,
)


GEMINI_PRICING: dict[str, Any] = {
    "provider": "google",
    "input_per_million": 1.20,
    "output_per_million": 5.00,
    "cached_input_per_million": 0.30,
    "cache_write_per_million": 0.0,
    "cache_write_multiplier": 1.25,
    "cached_is_subset_of_input": True,
    "thinking_billed_as_output": True,
}

ANTHROPIC_PRICING: dict[str, Any] = {
    "provider": "anthropic",
    "input_per_million": 3.00,
    "output_per_million": 15.00,
    "cached_input_per_million": 0.30,
    "cache_write_per_million": 0.0,
    "cache_write_multiplier": 1.25,
    "cached_is_subset_of_input": False,
    "thinking_billed_as_output": False,
}

OPENAI_PRICING: dict[str, Any] = {
    "provider": "openai",
    "input_per_million": 2.50,
    "output_per_million": 10.00,
    "cached_input_per_million": 1.25,
    "cache_write_per_million": 0.0,
    "cache_write_multiplier": 1.0,
    "cached_is_subset_of_input": True,
    "thinking_billed_as_output": False,
}


def _observer() -> RunObserver:
    registry = RunRegistry()
    status = ObservabilityStatus(enabled=False, project="test", default_dataset_name="test")
    return registry.create("cost-math-run", "tester", status)


def _settings_with_pricing(rows: dict[str, dict[str, Any]]) -> Settings:
    settings = Settings()
    settings.model_pricing_json = json.dumps(rows)
    return settings


# ---------------------------------------------------------------------------
# Pure estimator math
# ---------------------------------------------------------------------------


def test_estimate_usage_cost_gemini_subset_with_thinking() -> None:
    costs = estimate_usage_cost(
        1_000_000,
        100_000,
        cached_input_tokens=400_000,
        thinking_tokens=50_000,
        input_per_million=1.20,
        output_per_million=5.00,
        cached_input_per_million=0.30,
        cached_is_subset_of_input=True,
        thinking_billed_as_output=True,
    )
    # billable_input = 1_000_000 - 400_000 - 0 = 600_000 -> 600_000/1e6 * $1.20 = $0.72
    # cached         = 400_000/1e6 * $0.30 = $0.12
    # output         = 100_000/1e6 * $5.00 = $0.50
    # thinking       =  50_000/1e6 * $5.00 = $0.25
    # total          = 0.72 + 0.12 + 0.50 + 0.25 = $1.59
    assert costs["estimated_input_cost_usd"] == pytest.approx(0.72)
    assert costs["estimated_cached_input_cost_usd"] == pytest.approx(0.12)
    assert costs["estimated_output_cost_usd"] == pytest.approx(0.50)
    assert costs["estimated_thinking_cost_usd"] == pytest.approx(0.25)
    assert costs["estimated_total_cost_usd"] == pytest.approx(1.59)


def test_estimate_usage_cost_anthropic_disjoint_read_write() -> None:
    costs = estimate_usage_cost(
        200_000,
        50_000,
        cached_input_tokens=800_000,
        cache_write_input_tokens=100_000,
        input_per_million=3.00,
        output_per_million=15.00,
        cached_input_per_million=0.30,
        cache_write_multiplier=1.25,
        cached_is_subset_of_input=False,
    )
    # DISJOINT: input excludes cache buckets -> billable_input = 200_000
    # input     = 200_000/1e6 * $3.00 = $0.60
    # read      = 800_000/1e6 * $0.30 = $0.24   (NOT clamped to 200_000)
    # write     = 100_000/1e6 * ($0.30 * 1.25 = $0.375) = $0.0375
    # output    =  50_000/1e6 * $15.00 = $0.75
    # total     = 0.60 + 0.24 + 0.0375 + 0.75 = $1.6275
    assert costs["estimated_input_cost_usd"] == pytest.approx(0.60)
    assert costs["estimated_cached_input_cost_usd"] == pytest.approx(0.24)
    assert costs["estimated_cache_write_cost_usd"] == pytest.approx(0.0375)
    assert costs["estimated_output_cost_usd"] == pytest.approx(0.75)
    assert costs["estimated_total_cost_usd"] == pytest.approx(1.6275)


def test_estimate_usage_cost_openai_reasoning_not_double_billed() -> None:
    costs = estimate_usage_cost(
        500_000,
        200_000,
        cached_input_tokens=100_000,
        thinking_tokens=40_000,
        input_per_million=2.50,
        output_per_million=10.00,
        cached_input_per_million=1.25,
        cached_is_subset_of_input=True,
        thinking_billed_as_output=False,
    )
    # completion_tokens already includes reasoning_tokens -> thinking billed $0.
    # billable_input = 500_000 - 100_000 = 400_000 -> 400_000/1e6 * $2.50 = $1.00
    # cached         = 100_000/1e6 * $1.25 = $0.125
    # output         = 200_000/1e6 * $10.00 = $2.00
    # thinking       = $0.00 (flag False)
    # total          = 1.00 + 0.125 + 2.00 = $3.125
    assert costs["estimated_input_cost_usd"] == pytest.approx(1.00)
    assert costs["estimated_cached_input_cost_usd"] == pytest.approx(0.125)
    assert costs["estimated_output_cost_usd"] == pytest.approx(2.00)
    assert costs["estimated_thinking_cost_usd"] == 0.0
    assert costs["estimated_total_cost_usd"] == pytest.approx(3.125)


@pytest.mark.parametrize(
    ("billed_as_output", "expected_thinking"),
    [(True, 1.00), (False, 0.00)],
    ids=("billed", "already-in-output"),
)
def test_estimate_usage_cost_thinking_bucket_flag(billed_as_output: bool, expected_thinking: float) -> None:
    costs = estimate_usage_cost(
        0,
        0,
        thinking_tokens=250_000,
        output_per_million=4.00,
        thinking_billed_as_output=billed_as_output,
    )
    # thinking = 250_000/1e6 * $4.00 = $1.00 when flagged, else $0.00
    assert costs["estimated_thinking_cost_usd"] == pytest.approx(expected_thinking)
    assert costs["estimated_total_cost_usd"] == pytest.approx(expected_thinking)


def test_estimate_usage_cost_subset_floors_at_zero_without_clamping_cached() -> None:
    costs = estimate_usage_cost(
        100_000,
        0,
        cached_input_tokens=400_000,
        input_per_million=1.20,
        cached_input_per_million=0.30,
        cached_is_subset_of_input=True,
    )
    # Malformed payload where cached > input: billable floors at 0 -> $0.00,
    # while cached stays billed IN FULL (old min(cached, input) clamp would
    # have truncated it to 100_000 -> $0.03).
    # cached = 400_000/1e6 * $0.30 = $0.12 ; total = $0.12
    assert costs["estimated_input_cost_usd"] == 0.0
    assert costs["estimated_cached_input_cost_usd"] == pytest.approx(0.12)
    assert costs["estimated_total_cost_usd"] == pytest.approx(0.12)


def test_estimate_usage_cost_explicit_write_rate_beats_multiplier() -> None:
    costs = estimate_usage_cost(
        0,
        0,
        cache_write_input_tokens=200_000,
        cached_input_per_million=0.30,
        cache_write_per_million=0.50,
        cache_write_multiplier=1.25,
        cached_is_subset_of_input=False,
    )
    # Explicit catalog write rate wins over multiplier: 200_000/1e6 * $0.50 = $0.10
    assert costs["estimated_cache_write_cost_usd"] == pytest.approx(0.10)


# ---------------------------------------------------------------------------
# Observer end-to-end per family
# ---------------------------------------------------------------------------


def test_observer_prices_gemini_native_cached_content_payload() -> None:
    observer = _observer()
    usage = {
        "prompt_token_count": 1_000_000,
        "candidates_token_count": 100_000,
        "cached_content_token_count": 400_000,
        "thoughts_token_count": 50_000,
    }
    rollup = observer.add_llm_usage(
        usage,
        model_name="gemini-2.5-flash",
        provider="google",
        pricing=GEMINI_PRICING,
    )
    # Same arithmetic as the pure Gemini case: $0.72 + $0.12 + $0.50 + $0.25 = $1.59
    assert rollup["cost_source"] == "provider_pricing_catalog"
    assert rollup["cached_input_tokens"] == 400_000
    assert rollup["new_input_tokens"] == 600_000
    assert rollup["thinking_tokens"] == 50_000
    assert rollup["estimated_input_cost_usd"] == pytest.approx(0.72)
    assert rollup["estimated_cached_input_cost_usd"] == pytest.approx(0.12)
    assert rollup["estimated_output_cost_usd"] == pytest.approx(0.50)
    assert rollup["estimated_thinking_cost_usd"] == pytest.approx(0.25)
    assert rollup["estimated_total_cost_usd"] == pytest.approx(1.59)

    metrics = observer.trace().metrics
    assert metrics.total_cached_input_tokens == 400_000
    assert metrics.total_new_input_tokens == 600_000
    # Thinking dollars fold into the stored output-cost line: 0.50 + 0.25 = 0.75
    assert metrics.estimated_output_cost_usd == pytest.approx(0.75)
    assert metrics.estimated_total_cost_usd == pytest.approx(1.59)


def test_observer_prices_anthropic_disjoint_without_clamp_or_double_discount() -> None:
    observer = _observer()
    usage = {
        "input_tokens": 200_000,
        "output_tokens": 50_000,
        "cache_read_input_tokens": 800_000,
        "cache_creation_input_tokens": 100_000,
    }
    rollup = observer.add_llm_usage(
        usage,
        model_name="claude-sonnet-4",
        provider="anthropic",
        pricing=ANTHROPIC_PRICING,
    )
    # Same arithmetic as the pure disjoint case: 0.60 + 0.24 + 0.0375 + 0.75 = $1.6275
    # Old code: clamp truncated reads to min(800k, 200k)=200k AND subtracted the
    # write from a base that never contained it -> double discount.
    assert rollup["cost_source"] == "provider_pricing_catalog"
    assert rollup["new_input_tokens"] == 200_000
    assert rollup["cached_input_tokens"] == 800_000
    assert rollup["estimated_input_cost_usd"] == pytest.approx(0.60)
    assert rollup["estimated_cached_input_cost_usd"] == pytest.approx(0.24)
    assert rollup["estimated_cache_write_cost_usd"] == pytest.approx(0.0375)
    assert rollup["estimated_output_cost_usd"] == pytest.approx(0.75)
    assert rollup["estimated_total_cost_usd"] == pytest.approx(1.6275)

    model_usage = observer.trace().metrics.model_usage[0]
    assert model_usage.new_input_tokens == 200_000
    assert model_usage.estimated_total_cost_usd == pytest.approx(1.6275)


def test_unpriced_model_emits_warning_event_once_per_model() -> None:
    observer = _observer()
    usage = {"input_tokens": 1_000, "output_tokens": 500}

    first = observer.add_llm_usage(usage, model_name="mystery-model", provider="")
    assert first["cost_source"] == "unpriced"
    assert first["estimated_total_cost_usd"] == 0.0

    observer.add_llm_usage(usage, model_name="mystery-model", provider="")
    observer.add_llm_usage(usage, model_name="other-model", provider="nvidia")

    warnings = [event for event in observer.trace().events if event.kind == "pricing_missing"]
    # One warning per distinct model name, not per call.
    assert len(warnings) == 2
    assert all(event.status == "warning" for event in warnings)
    assert {event.details["model_name"] for event in warnings} == {"mystery-model", "other-model"}

    metrics = observer.trace().metrics
    assert metrics.total_llm_calls == 3
    assert metrics.estimated_total_cost_usd == 0.0


# ---------------------------------------------------------------------------
# Pricing resolution: exact / alias / never-fuzzy
# ---------------------------------------------------------------------------


def test_resolve_model_pricing_exact_composite_and_routed_matches() -> None:
    settings = _settings_with_pricing(
        {
            "gemini-2.5-flash": {
                "provider": "google",
                "input_per_million": 0.30,
                "output_per_million": 2.50,
            },
            "gemini-2.5-pro": {
                "provider": "google",
                "input_per_million": 1.25,
                "output_per_million": 10.00,
            },
        }
    )
    exact = resolve_model_pricing(settings, "gemini-2.5-flash")
    assert exact is not None
    assert exact["input_per_million"] == pytest.approx(0.30)

    composite = resolve_model_pricing(settings, "gemini-2.5-pro", "google_genai")
    assert composite is not None
    assert composite["output_per_million"] == pytest.approx(10.00)

    routed = resolve_model_pricing(settings, "gemini/gemini-2.5-flash")
    assert routed is not None
    assert routed["input_per_million"] == pytest.approx(0.30)


def test_resolve_model_pricing_alias_table_maps_to_canonical_row() -> None:
    settings = _settings_with_pricing(
        {
            "gemini-2.5-flash": {
                "provider": "google",
                "input_per_million": 0.30,
                "output_per_million": 2.50,
            }
        }
    )
    aliased = resolve_model_pricing(settings, "gemini-flash-latest", "google")
    assert aliased is not None
    assert aliased["input_per_million"] == pytest.approx(0.30)
    assert aliased["output_per_million"] == pytest.approx(2.50)


def test_flash_lite_never_binds_flash_rates() -> None:
    settings = _settings_with_pricing(
        {
            "gemini-2.5-flash": {
                "provider": "google",
                "input_per_million": 0.30,
                "output_per_million": 2.50,
            },
            "claude-3-5-sonnet": {
                "provider": "anthropic",
                "input_per_million": 3.00,
                "output_per_million": 15.00,
            },
        }
    )
    # Regression COST-F4: prefix matching bound flash-lite to flash (~4x overprice);
    # the old "-20" strip bound date-suffixed names to their bare cousins.
    assert resolve_model_pricing(settings, "gemini-2.5-flash-lite") is None
    assert resolve_model_pricing(settings, "claude-3-5-sonnet-20240620") is None
    assert get_model_pricing_for_settings(settings, "gemini-2.5-flash-lite") == {}


def test_flash_lite_alias_resolves_to_lite_rates_not_flash_rates() -> None:
    settings = _settings_with_pricing(
        {
            "gemini-2.5-flash": {
                "provider": "google",
                "input_per_million": 0.30,
                "output_per_million": 2.50,
            },
            "gemini-2.5-flash-lite": {
                "provider": "google",
                "input_per_million": 0.10,
                "output_per_million": 0.40,
            },
        }
    )
    resolved = resolve_model_pricing(settings, "gemini-flash-lite-latest", "google")
    assert resolved is not None
    # Must bind to the LITE row ($0.10), never the flash row ($0.30).
    assert resolved["input_per_million"] == pytest.approx(0.10)
    assert resolved["output_per_million"] == pytest.approx(0.40)


# ---------------------------------------------------------------------------
# Provider pricing dispatch
# ---------------------------------------------------------------------------


def _dispatch_recorder(monkeypatch: pytest.MonkeyPatch, name: str, marker: Any) -> list[tuple[tuple, dict]]:
    calls: list[tuple[tuple, dict]] = []

    def recorder(*args: Any, **kwargs: Any) -> list[Any]:
        calls.append((args, kwargs))
        return [marker]

    monkeypatch.setattr(provider_pricing, name, recorder)
    return calls


@pytest.mark.parametrize(
    ("provider", "parser_name"),
    [
        ("openai", "_fetch_openai_pricing"),
        ("anthropic", "_fetch_anthropic_pricing"),
        ("openrouter", "_fetch_openrouter_pricing"),
        ("nvidia", "_fetch_nvidia_pricing"),
        ("nvidia_nim", "_fetch_nvidia_pricing"),
        ("google", "_fetch_google_pricing"),
        ("google_genai", "_fetch_google_pricing"),
    ],
)
def test_fetch_provider_pricing_routes_each_family(
    monkeypatch: pytest.MonkeyPatch, provider: str, parser_name: str
) -> None:
    marker = object()
    calls = _dispatch_recorder(monkeypatch, parser_name, marker)
    settings = Settings()

    result = provider_pricing.fetch_provider_pricing(
        settings, provider=provider, timeout_seconds=7, max_models=42
    )

    assert result == [marker]
    assert len(calls) == 1
    _, kwargs = calls[0]
    assert kwargs["timeout_seconds"] == 7
    assert kwargs["max_models"] == 42


def test_fetch_provider_pricing_unknown_provider_raises_value_error() -> None:
    settings = Settings()
    with pytest.raises(ValueError, match="no parser"):
        provider_pricing.fetch_provider_pricing(settings, provider="unknown-vendor")
