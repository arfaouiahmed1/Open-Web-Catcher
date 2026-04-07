"""Dynamic QA/test controls for the Gradio dashboard."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import gradio as gr
import httpx

from src.evaluation.tool_benchmarks import TOOL_BENCHMARKS
from src.utils.config import Settings

PROJECT_ROOT = Path(__file__).resolve().parents[3]
TESTS_ROOT = PROJECT_ROOT / "tests"

CORE_TEST_TARGETS = [
    "tests/test_agents.py",
    "tests/test_agent_loop.py",
    "tests/test_tools.py",
    "tests/test_mcp_client.py",
    "tests/test_prompts.py",
    "tests/test_tool_benchmarks.py",
]


def discover_pytest_targets() -> list[str]:
    return sorted(
        str(path.relative_to(PROJECT_ROOT)).replace("\\", "/")
        for path in TESTS_ROOT.glob("test_*.py")
    )


def default_pytest_targets() -> list[str]:
    available = set(discover_pytest_targets())
    defaults = [target for target in CORE_TEST_TARGETS if target in available]
    return defaults or sorted(available)[:6]


def benchmark_tool_choices() -> list[str]:
    return sorted(TOOL_BENCHMARKS)


def default_benchmark_tools() -> list[str]:
    preferred = ["open_url", "get_page_context", "capture_streams"]
    available = set(benchmark_tool_choices())
    defaults = [tool for tool in preferred if tool in available]
    return defaults or benchmark_tool_choices()[:3]


def quality_mode_updates(mode: str):
    is_python = (mode or "").strip() != "tool_benchmarks"
    return (
        gr.update(visible=is_python),
        gr.update(visible=not is_python),
    )


def _build_pytest_command(targets: list[str], keyword: str = "", fail_fast: bool = False) -> list[str]:
    selected_targets = targets or default_pytest_targets()
    command = [
        sys.executable,
        "-m",
        "pytest",
        *selected_targets,
        "-q",
        "--tb=short",
        "--asyncio-mode=auto",
    ]
    if keyword.strip():
        command.extend(["-k", keyword.strip()])
    if fail_fast:
        command.append("-x")
    return command


def _build_benchmark_command(
    tools: list[str],
    benchmark_mode: str = "mock",
    repeat: int = 1,
    base_url: str = "https://example.com",
) -> list[str]:
    selected_tools = tools or default_benchmark_tools()
    command = [
        sys.executable,
        "scripts/benchmark_tools.py",
        "--mode",
        benchmark_mode or "mock",
        "--repeat",
        str(max(int(repeat or 1), 1)),
        "--base-url",
        base_url.strip() or "https://example.com",
        "--json",
    ]
    for tool in selected_tools:
        command.extend(["--tool", tool])
    return command


def _shell_preview(command: list[str]) -> str:
    return " ".join(f'"{part}"' if " " in part else part for part in command)


def load_tool_catalog(settings: Settings) -> tuple[str, str]:
    probe_url = f"{settings.mcp_server_url.rstrip('/')}/tools"
    try:
        response = httpx.get(probe_url, timeout=5.0)
        response.raise_for_status()
        payload = response.json()
        markdown = "\n".join(
            [
                "### Tool Catalog",
                f"- MCP URL: `{settings.mcp_server_url}`",
                f"- Tools discovered: `{len(payload)}`",
                f"- Names: " + ", ".join(f"`{name}`" for name in sorted(payload)),
            ]
        )
        return markdown, response.text
    except Exception as exc:
        return (
            "\n".join(
                [
                    "### Tool Catalog",
                    f"- MCP URL: `{settings.mcp_server_url}`",
                    f"- Error: `{exc}`",
                ]
            ),
            "{}",
        )


def run_quality_task(
    mode: str,
    pytest_targets: list[str],
    keyword: str,
    fail_fast: bool,
    benchmark_tools: list[str],
    benchmark_mode: str,
    repeat: int,
    base_url: str,
) -> tuple[str, str, str]:
    selected_mode = (mode or "").strip()
    if selected_mode == "tool_benchmarks":
        command = _build_benchmark_command(benchmark_tools, benchmark_mode, repeat, base_url)
        title = "Tool Benchmarks"
    else:
        command = _build_pytest_command(pytest_targets, keyword, fail_fast)
        title = "Python Test Suite"

    result = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=1800,
    )
    combined_output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    summary = "\n".join(
        [
            f"### {title}",
            f"- Exit code: `{result.returncode}`",
            f"- Command: `{_shell_preview(command)}`",
            f"- Status: `{'PASS' if result.returncode == 0 else 'FAIL'}`",
        ]
    )
    return summary, _shell_preview(command), combined_output.strip()
