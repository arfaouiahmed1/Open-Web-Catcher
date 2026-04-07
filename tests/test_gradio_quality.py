"""Regression tests for the lightweight Gradio QA helpers."""

from __future__ import annotations

from src.api.gradio import quality as quality
from src.evaluation.tool_benchmarks import TOOL_BENCHMARKS


def test_discover_pytest_targets_includes_core_suites():
    targets = quality.discover_pytest_targets()

    assert "tests/test_agents.py" in targets
    assert "tests/test_agent_loop.py" in targets
    assert "tests/test_tools.py" in targets
    assert "tests/test_mcp_client.py" in targets
    assert "tests/test_prompts.py" in targets
    assert "tests/test_tool_benchmarks.py" in targets


def test_default_pytest_targets_are_available_and_non_empty():
    discovered = set(quality.discover_pytest_targets())
    defaults = quality.default_pytest_targets()

    assert defaults
    assert set(defaults).issubset(discovered)


def test_benchmark_tool_choices_match_catalog():
    assert quality.benchmark_tool_choices() == sorted(TOOL_BENCHMARKS)


def test_quality_mode_updates_toggle_groups():
    pytest_group, benchmark_group = quality.quality_mode_updates("python_tests")
    assert pytest_group["visible"] is True
    assert benchmark_group["visible"] is False

    pytest_group, benchmark_group = quality.quality_mode_updates("tool_benchmarks")
    assert pytest_group["visible"] is False
    assert benchmark_group["visible"] is True


def test_build_pytest_command_keeps_suite_targeting_lightweight():
    command = quality._build_pytest_command(["tests/test_agents.py"], keyword="agents", fail_fast=True)
    rendered = " ".join(command)

    assert " -m pytest " in f" {rendered} "
    assert "tests/test_agents.py" in command
    assert "-q" in command
    assert "--tb=short" in command
    assert "--asyncio-mode=auto" in command
    assert "-k" in command
    assert "agents" in command
    assert "-x" in command


def test_build_benchmark_command_supports_repeat_and_base_url():
    command = quality._build_benchmark_command(
        ["open_url"],
        benchmark_mode="mock",
        repeat=2,
        base_url="http://bench.local",
    )
    rendered = " ".join(command)

    assert "scripts/benchmark_tools.py" in rendered
    assert "--mode" in command
    assert "mock" in command
    assert "--repeat" in command
    assert "2" in command
    assert "--tool" in command
    assert "open_url" in command
    assert "--base-url" in command
    assert "http://bench.local" in command
    assert "--json" in command
