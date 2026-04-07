"""Shared UI constants and lightweight component helpers for the Gradio app."""

from __future__ import annotations

import gradio as gr


def compat_chatbot(**kwargs):
    """Build a Chatbot across Gradio versions that may not support `type`."""
    try:
        return gr.Chatbot(**kwargs)
    except TypeError:
        kwargs.pop("type", None)
        return gr.Chatbot(**kwargs)


APP_CSS = """
.app-shell {max-width: 1520px; margin: 0 auto; padding-bottom: 2rem;}
.hero {padding: 1.35rem 1.5rem; border-radius: 24px; background:
linear-gradient(135deg, #13293d 0%, #1b4965 45%, #5fa8d3 100%);
color: #f6fbff; box-shadow: 0 16px 40px rgba(19, 41, 61, 0.22);}
.hero h1 {margin: 0; font-size: 2rem;}
.hero p {margin: 0.55rem 0 0 0; max-width: 960px;}
.panel-note {padding: 0.9rem 1rem; border-radius: 16px; background: #f4efe6; border: 1px solid #e3d4bc;}
.status-card {padding: 1rem 1.1rem; border-radius: 18px; background: #fffaf3; border: 1px solid #eadbc8;}
.run-card {padding: 1rem 1.1rem; border-radius: 18px; background: #f8fbfd; border: 1px solid #d6e2ea;}
.flow-shell {padding: 0.85rem; border-radius: 18px; background: linear-gradient(180deg, #fbfdff 0%, #f2f6f8 100%); border: 1px solid #d9e4ea;}
.flow-root {display: inline-block; padding: 0.7rem 1rem; border-radius: 999px; background: #13293d; color: #fff; font-weight: 700; margin: 0 auto;}
.flow-divider {font-size: 1.2rem; text-align: center; color: #5f7d8f; margin: 0.25rem 0 0.55rem;}
.flow-row {display: flex; flex-wrap: wrap; gap: 0.85rem; justify-content: center; align-items: flex-start;}
.flow-branch {min-width: 240px; max-width: 330px; border: 1px solid #d8e5ea; border-radius: 16px; background: #fff; padding: 0.85rem;}
.flow-branch.active {border-color: #1b4965; box-shadow: 0 0 0 2px rgba(27, 73, 101, 0.1);}
.flow-actor {display: inline-block; padding: 0.45rem 0.75rem; border-radius: 999px; background: #e9f3f8; color: #163247; font-weight: 700;}
.flow-tools {display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.65rem;}
.flow-tool {display: inline-block; padding: 0.35rem 0.6rem; border-radius: 999px; background: #f4efe6; color: #5b4332; font-size: 0.9rem;}
.flow-empty {padding: 1rem; text-align: center; color: #5e7280;}
.flow-grid {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; margin-top: 0.7rem;}
.flow-stat {padding: 0.55rem 0.65rem; border-radius: 12px; background: #f7fafb; border: 1px solid #e1ebf0;}
.flow-meta {margin-top: 0.65rem; color: #486171; font-size: 0.92rem;}
.mini-label {font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6f8594;}
"""

EVENT_HEADERS = [
    "Seq",
    "Time",
    "Actor",
    "Kind",
    "Status",
    "Tool",
    "Model",
    "Provider",
    "Tokens",
    "Message",
]

DATASET_HEADERS = [
    "URL",
    "Status",
    "Streams",
    "Providers",
    "Success",
    "LLM Calls",
    "Tool Calls",
    "Cost USD",
]

AGENT_OPTIONS = [
    ("Classification", "classification"),
    ("Landing Page", "landing"),
    ("Hosting Page", "hosting"),
    ("Embedded Page", "embedded"),
]

AGENT_LABELS = {
    "classification": "Classification",
    "landing": "Landing Page",
    "hosting": "Hosting Page",
    "embedded": "Embedded Page",
    "orchestrator": "Orchestrator",
}

PAGE_TYPE_OPTIONS = ["any", "landing_page", "hosting_page", "embedded_page", "unknown"]
STATUS_OPTIONS = ["any", "success", "partial", "failed"]

QUALITY_MODE_OPTIONS = [
    ("Python Test Suite", "python_tests"),
    ("Tool Benchmarks", "tool_benchmarks"),
]

BENCHMARK_MODE_OPTIONS = [
    ("Mock (Recommended)", "mock"),
    ("Live MCP", "live"),
]

DEFAULT_QUEUE_CONCURRENCY_LIMIT = 2
