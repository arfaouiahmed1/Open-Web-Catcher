"""Coverage tests for the MCP tool benchmark catalog."""

from __future__ import annotations

from src.evaluation.tool_benchmarks import TOOL_BENCHMARKS, expected_benchmark_tool_names


def test_benchmark_catalog_covers_every_required_mcp_tool():
    assert set(TOOL_BENCHMARKS) == expected_benchmark_tool_names()


def test_benchmark_cases_render_base_urls_consistently():
    rendered = TOOL_BENCHMARKS["capture_streams"].render(base_url="http://bench.local")

    assert rendered.setup_steps[0].args["url"] == "http://bench.local/hosting"
    assert rendered.benchmark_step.args["player_iframe_hint"] == "player"
