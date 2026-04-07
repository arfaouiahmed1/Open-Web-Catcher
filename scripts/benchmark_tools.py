"""Benchmark MCP tools using either a live MCP server or a local mock harness."""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import asdict
from typing import Any

from src.evaluation.tool_benchmarks import TOOL_BENCHMARKS, ToolBenchmarkCase, get_all_benchmark_cases
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings


class MockTool:
    def __init__(self, name: str) -> None:
        self.name = name

    async def ainvoke(self, args: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0.01)
        return {"ok": True, "tool_name": self.name, "echo": args}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("mock", "live"), default="mock")
    parser.add_argument("--tool", action="append", dest="tools", help="Benchmark only the named tool. Repeat for multiple tools.")
    parser.add_argument("--repeat", type=int, default=3, help="Number of repetitions per benchmark.")
    parser.add_argument("--base-url", default="https://example.com", help="Base URL substituted into benchmark scenarios.")
    parser.add_argument("--list", action="store_true", help="Print the comprehensive benchmark catalog and exit.")
    parser.add_argument("--json", action="store_true", help="Emit JSON output.")
    return parser


def _select_cases(selected_tools: list[str] | None) -> list[ToolBenchmarkCase]:
    if not selected_tools:
        return get_all_benchmark_cases()
    return [TOOL_BENCHMARKS[name] for name in selected_tools]


async def _run_case_mock(case: ToolBenchmarkCase, repeat: int) -> dict[str, Any]:
    durations_ms: list[float] = []
    tool = MockTool(case.tool_name)

    for _ in range(repeat):
        for step in case.setup_steps:
            await MockTool(step.tool_name).ainvoke(step.args)
        started = time.perf_counter()
        await tool.ainvoke(case.benchmark_step.args)
        durations_ms.append((time.perf_counter() - started) * 1000.0)

    return _summarize_case(case, durations_ms)


async def _run_case_live(case: ToolBenchmarkCase, repeat: int) -> dict[str, Any]:
    settings = Settings.from_yaml()
    durations_ms: list[float] = []

    for _ in range(repeat):
        async with agent_tools(case.profile, settings) as tools:
            tool_map = {tool.name: tool for tool in tools}
            for step in case.setup_steps:
                await tool_map[step.tool_name].ainvoke(step.args)
            started = time.perf_counter()
            await tool_map[case.benchmark_step.tool_name].ainvoke(case.benchmark_step.args)
            durations_ms.append((time.perf_counter() - started) * 1000.0)

    return _summarize_case(case, durations_ms)


def _summarize_case(case: ToolBenchmarkCase, durations_ms: list[float]) -> dict[str, Any]:
    return {
        "tool_name": case.tool_name,
        "profile": case.profile,
        "scenario": case.scenario,
        "description": case.description,
        "setup_steps": [asdict(step) for step in case.setup_steps],
        "benchmark_step": asdict(case.benchmark_step),
        "repeat": len(durations_ms),
        "min_ms": round(min(durations_ms), 3),
        "max_ms": round(max(durations_ms), 3),
        "mean_ms": round(statistics.fmean(durations_ms), 3),
        "median_ms": round(statistics.median(durations_ms), 3),
        "tags": list(case.tags),
    }


async def _main_async(args: argparse.Namespace) -> int:
    cases = [case.render(base_url=args.base_url) for case in _select_cases(args.tools)]

    if args.list:
        payload = [
            {
                "tool_name": case.tool_name,
                "profile": case.profile,
                "description": case.description,
                "scenario": case.scenario,
                "setup_steps": [asdict(step) for step in case.setup_steps],
                "benchmark_step": asdict(case.benchmark_step),
                "tags": list(case.tags),
            }
            for case in cases
        ]
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            for case in payload:
                print(f"{case['tool_name']} [{case['profile']}]")
                print(f"  Scenario: {case['scenario']}")
                print(f"  Description: {case['description']}")
        return 0

    runner = _run_case_live if args.mode == "live" else _run_case_mock
    results = [await runner(case, args.repeat) for case in cases]

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for item in results:
            print(
                f"{item['tool_name']} [{item['profile']}] "
                f"mean={item['mean_ms']}ms median={item['median_ms']}ms "
                f"min={item['min_ms']}ms max={item['max_ms']}ms"
            )

    return 0


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
