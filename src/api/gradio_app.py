"""Interactive Gradio dashboard for live runs, control, observability, and datasets."""

from __future__ import annotations

import asyncio
from collections import Counter
import html
import json
import threading
import time
import uuid
from typing import Any

import gradio as gr

from src.agents.base import RunCancelledError
from src.agents.classification import ClassificationAgent
from src.agents.embedded_page import EmbeddedPageAgent
from src.agents.hosting_page import HostingPageAgent
from src.agents.landing_page import LandingPageAgent
from src.agents.orchestrator import run_pipeline
from src.evaluation.datasets import (
    build_dataset_examples,
    export_dataset_examples,
    publish_dataset_to_phoenix,
)
from src.evaluation.tracing import setup_tracing_from_settings
from src.models.enums import ExtractionStatus
from src.models.schemas import ClassificationResult, ExtractionResult, PipelineResult, RunMetrics
from src.storage.database import get_session
from src.storage.repositories import RunRepository
from src.utils.config import Settings
from src.utils.logging import get_logger, setup_logging
from src.utils.observability import RunObserver, RunTrace, RuntimeEvent, get_tracing_status, run_registry

settings = Settings.from_yaml()
logger = get_logger(__name__)

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


def _normalize_agent_key(agent_key: str) -> str:
    normalized = (agent_key or "").strip().lower()
    return normalized if normalized in AGENT_LABELS else "classification"


def _agent_label(agent_key: str) -> str:
    return AGENT_LABELS.get(_normalize_agent_key(agent_key), agent_key or "Unknown")


def _json_dump(value: Any) -> str:
    if value is None:
        return "{}"
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.dumps(value, indent=2, ensure_ascii=False, default=str)


def _state_to_trace(trace_state: Any) -> RunTrace | None:
    if not trace_state:
        return None
    if isinstance(trace_state, RunTrace):
        return trace_state
    try:
        return RunTrace.model_validate(trace_state)
    except Exception:
        return None


def _trace_to_state(trace: RunTrace | None) -> dict[str, Any]:
    return trace.model_dump(mode="json") if trace is not None else {}


def _trace_actor_choices(trace: RunTrace | None) -> list[str]:
    choices = ["all"]
    if trace is None:
        return choices
    for actor in [trace.root_actor] + [event.actor for event in trace.events]:
        if actor and actor not in choices:
            choices.append(actor)
    return choices


def _trace_kind_choices(trace: RunTrace | None) -> list[str]:
    choices = ["all"]
    if trace is None:
        return choices
    for event in trace.events:
        if event.kind and event.kind not in choices:
            choices.append(event.kind)
    return choices


def _trace_status_choices(trace: RunTrace | None) -> list[str]:
    choices = ["all"]
    if trace is None:
        return choices
    for event in trace.events:
        if event.status and event.status not in choices:
            choices.append(event.status)
    return choices


def _filter_events(
    trace: RunTrace | None,
    actor: str = "all",
    kind: str = "all",
    status: str = "all",
) -> list[RuntimeEvent]:
    if trace is None:
        return []
    events = list(trace.events)
    if actor != "all":
        events = [event for event in events if event.actor == actor]
    if kind != "all":
        events = [event for event in events if event.kind == kind]
    if status != "all":
        events = [event for event in events if event.status == status]
    return events


def _event_rows(events: list[RuntimeEvent]) -> list[list[str]]:
    rows: list[list[str]] = []
    for event in events:
        details = event.details or {}
        token_summary = ""
        if "input_tokens" in details or "output_tokens" in details:
            token_summary = f"{details.get('input_tokens', 0)} / {details.get('output_tokens', 0)}"
        rows.append(
            [
                str(event.seq),
                event.timestamp.strftime("%H:%M:%S"),
                event.actor,
                event.kind,
                event.status,
                str(details.get("tool_name", "")),
                str(details.get("model_name", "")),
                str(details.get("provider", "")),
                token_summary,
                event.message,
            ]
        )
    return rows


def _latest_provider_event(events: list[RuntimeEvent]) -> RuntimeEvent | None:
    for event in reversed(events):
        if event.kind == "llm_response":
            return event
    return None


def _actor_stats(trace: RunTrace | None, events: list[RuntimeEvent]) -> dict[str, dict[str, Any]]:
    stats: dict[str, dict[str, Any]] = {}
    if trace is not None:
        stats[trace.root_actor] = {
            "events": 0,
            "llm_calls": 0,
            "tool_calls": 0,
            "tools": [],
            "latest_kind": "",
            "latest_status": "",
            "latest_tool": "",
            "provider": "",
            "model_name": "",
        }

    for event in events:
        actor = event.actor or "unknown"
        details = event.details or {}
        entry = stats.setdefault(
            actor,
            {
                "events": 0,
                "llm_calls": 0,
                "tool_calls": 0,
                "tools": [],
                "latest_kind": "",
                "latest_status": "",
                "latest_tool": "",
                "provider": "",
                "model_name": "",
            },
        )
        entry["events"] += 1
        entry["latest_kind"] = event.kind
        entry["latest_status"] = event.status
        if event.kind == "llm_response":
            entry["llm_calls"] += 1
            entry["provider"] = str(details.get("provider", "") or "")
            entry["model_name"] = str(details.get("model_name", "") or "")
        if event.kind == "tool_call_started":
            entry["tool_calls"] += 1
        tool_name = str(details.get("tool_name", "") or "").strip()
        if tool_name:
            entry["latest_tool"] = tool_name
            if tool_name not in entry["tools"]:
                entry["tools"].append(tool_name)
    return stats


def _provider_payload_json(events: list[RuntimeEvent]) -> str:
    event = _latest_provider_event(events)
    if event is None:
        return "{}"
    return _json_dump(
        {
            "seq": event.seq,
            "timestamp": event.timestamp.isoformat(),
            "actor": event.actor,
            "status": event.status,
            "message": event.message,
            "details": event.details,
        }
    )


def _provider_markdown(events: list[RuntimeEvent]) -> str:
    provider_events = [event for event in events if event.kind == "llm_response"]
    if not provider_events:
        return "### Provider Feed\n_No provider responses yet._"

    latest = provider_events[-1]
    latest_details = latest.details or {}
    latest_tool_names = ", ".join(latest_details.get("tool_call_names", [])) or "none"
    response_meta = latest_details.get("response_metadata", {}) or {}
    usage_meta = latest_details.get("usage_metadata", {}) or {}

    blocks = [
        "### Provider Feed",
        f"- Latest actor: `{latest.actor}`",
        f"- Latest model: `{latest_details.get('provider', 'unknown')}` / `{latest_details.get('model_name', 'unknown')}`",
        f"- Latest tokens: `{latest_details.get('input_tokens', 0)}` / `{latest_details.get('output_tokens', 0)}`",
        f"- Latest requested tools: `{latest_tool_names}`",
        f"- Response metadata keys: `{', '.join(response_meta.keys()) or 'none'}`",
        f"- Usage metadata keys: `{', '.join(usage_meta.keys()) or 'none'}`",
        "",
    ]

    for event in reversed(provider_events[-3:]):
        details = event.details or {}
        preview = str(details.get("content_preview") or "_No text content returned._")[:900]
        requested_tools = ", ".join(details.get("tool_call_names", [])) or "none"
        blocks.extend(
            [
                f"#### Turn #{event.seq} | {event.actor}",
                f"- Status: `{event.status}`",
                f"- Model: `{details.get('provider', 'unknown')}` / `{details.get('model_name', 'unknown')}`",
                f"- Tokens in/out: `{details.get('input_tokens', 0)}` / `{details.get('output_tokens', 0)}`",
                f"- Requested tools: `{requested_tools}`",
                "```text",
                preview,
                "```",
                "",
            ]
        )
    return "\n".join(blocks).strip()


def _tool_inventory_markdown(
    trace: RunTrace | None,
    events: list[RuntimeEvent],
    actor: str = "all",
    kind: str = "all",
    status: str = "all",
) -> str:
    if trace is None:
        return "### Agent and Tool Inventory\n_No trace yet._"

    actor_stats = _actor_stats(trace, events)
    tool_counts: Counter[str] = Counter()
    for event in events:
        tool_name = str((event.details or {}).get("tool_name", "") or "").strip()
        if tool_name:
            tool_counts[tool_name] += 1

    lines = [
        "### Agent and Tool Inventory",
        f"- Scope: `actor={actor}` `kind={kind}` `status={status}`",
        f"- Actors in view: `{max(len([name for name, data in actor_stats.items() if data['events'] > 0]), 0)}`",
        f"- Unique tools in view: `{len(tool_counts)}`",
    ]

    if len(actor_stats) == 1 and next(iter(actor_stats.values()))["events"] == 0:
        lines.append("- No matching events are visible yet.")
        return "\n".join(lines)

    for actor_name, data in actor_stats.items():
        if data["events"] == 0 and actor_name != trace.root_actor:
            continue
        model_bits = " / ".join(bit for bit in [data["provider"], data["model_name"]] if bit) or "none"
        lines.append(
            f"- `{actor_name}` -> events `{data['events']}`, llm `{data['llm_calls']}`, tool calls `{data['tool_calls']}`, latest `{data['latest_kind'] or 'none'}` / `{data['latest_status'] or 'n/a'}`, model `{model_bits}`, latest tool `{data['latest_tool'] or 'none'}`"
        )

    if tool_counts:
        lines.append("- Tool counts: " + ", ".join(f"`{tool}` x{count}" for tool, count in tool_counts.most_common()))
    else:
        lines.append("- Tool counts: `none`")

    return "\n".join(lines)


def _run_control_markdown(trace: RunTrace | None, notice: str = "") -> str:
    if trace is None:
        return "### Run Control\n_No active run._"
    state = "Completed" if trace.completed else "Cancelling" if trace.cancel_requested else "Running"
    lines = [
        "### Run Control",
        f"- Run ID: `{trace.run_id}`",
        f"- State: `{state}`",
        f"- Root actor: `{trace.root_actor}`",
    ]
    if trace.cancel_reason:
        lines.append(f"- Cancel reason: `{trace.cancel_reason}`")
    if notice:
        lines.append(f"- Notice: {notice}")
    return "\n".join(lines)


def _render_trace_panels(
    trace_state: Any,
    actor: str = "all",
    kind: str = "all",
    status: str = "all",
) -> tuple[str, str, list[list[str]], str, str, str, str]:
    trace = _state_to_trace(trace_state)
    events = _filter_events(trace, actor, kind, status)
    if trace is None:
        empty_graph = "<div class='flow-shell'><div class='flow-empty'>No run graph yet.</div></div>"
        return (
            "### Live Activity\n_No trace yet._",
            empty_graph,
            [],
            "### Provider Feed\n_No provider responses yet._",
            "{}",
            "### Agent and Tool Inventory\n_No trace yet._",
            "{}",
        )

    full_latest = trace.events[-1] if trace.events else None
    visible_latest = events[-1] if events else full_latest
    latest_provider = _latest_provider_event(events) or _latest_provider_event(trace.events)
    latest_tool = "none"
    for event in reversed(events or trace.events):
        tool_name = str((event.details or {}).get("tool_name", "") or "").strip()
        if tool_name:
            latest_tool = tool_name
            break

    current_actor = visible_latest.actor if visible_latest else trace.root_actor
    latest_kind = visible_latest.kind if visible_latest else "none"
    latest_status = visible_latest.status if visible_latest else "n/a"
    latest_model = " / ".join(
        bit
        for bit in [
            str((latest_provider.details or {}).get("provider", "") or "") if latest_provider else "",
            str((latest_provider.details or {}).get("model_name", "") or "") if latest_provider else "",
        ]
        if bit
    ) or "none"
    metrics = trace.metrics
    summary_lines = [
        "### Live Activity",
        f"- Run ID: `{trace.run_id}`",
        f"- Run state: `{'Completed' if trace.completed else 'Cancelling' if trace.cancel_requested else 'Running'}`",
        f"- Current actor: `{current_actor}`",
        f"- Latest event: `{latest_kind}` / `{latest_status}`",
        f"- Latest tool: `{latest_tool}`",
        f"- Active model: `{latest_model}`",
        f"- Events in view: `{len(events)}` / total `{len(trace.events)}`",
        f"- Filters: `actor={actor}` `kind={kind}` `status={status}`",
    ]
    if metrics is not None:
        summary_lines.extend(
            [
                f"- Total llm calls: `{metrics.total_llm_calls}`",
                f"- Total tool calls: `{metrics.total_tool_calls}`",
                f"- Total messages: `{metrics.total_messages}`",
                f"- Tokens in/out: `{metrics.total_tokens_in}` / `{metrics.total_tokens_out}`",
                f"- Estimated cost: `${metrics.estimated_total_cost_usd:.6f}`",
            ]
        )
    summary = "\n".join(summary_lines)

    actor_stats = _actor_stats(trace, events)
    actor_order = [name for name in _trace_actor_choices(trace)[1:] if name in actor_stats]
    if actor != "all":
        actor_order = [name for name in actor_order if name in {trace.root_actor, actor}]
        if trace.root_actor not in actor_order:
            actor_order.insert(0, trace.root_actor)

    actor_cards: list[str] = []
    for actor_name in actor_order:
        data = actor_stats.get(actor_name, {})
        tools = data.get("tools", [])
        tool_markup = (
            "".join(f"<span class='flow-tool'>{html.escape(tool)}</span>" for tool in tools)
            or "<span class='flow-tool'>No tools yet</span>"
        )
        provider_label = " / ".join(
            bit for bit in [data.get("provider", ""), data.get("model_name", "")] if bit
        ) or "none"
        actor_cards.append(
            "".join(
                [
                    f"<div class='flow-branch{' active' if actor_name == current_actor else ''}'>",
                    "<div class='mini-label'>Agent</div>",
                    f"<div class='flow-actor'>{html.escape(actor_name)}</div>",
                    "<div class='flow-grid'>",
                    f"<div class='flow-stat'><div class='mini-label'>Events</div><div>{data.get('events', 0)}</div></div>",
                    f"<div class='flow-stat'><div class='mini-label'>LLM Calls</div><div>{data.get('llm_calls', 0)}</div></div>",
                    f"<div class='flow-stat'><div class='mini-label'>Tool Calls</div><div>{data.get('tool_calls', 0)}</div></div>",
                    f"<div class='flow-stat'><div class='mini-label'>Latest</div><div>{html.escape(data.get('latest_kind', 'none') or 'none')}</div></div>",
                    "</div>",
                    f"<div class='flow-meta'>Model: <strong>{html.escape(provider_label)}</strong><br/>Latest tool: <strong>{html.escape(data.get('latest_tool', 'none') or 'none')}</strong></div>",
                    "<div class='mini-label' style='margin-top:0.75rem;'>Tools Seen</div>",
                    f"<div class='flow-tools'>{tool_markup}</div>",
                    "</div>",
                ]
            )
        )

    if not actor_cards:
        actor_cards.append("<div class='flow-empty'>No events match the current filters yet.</div>")

    graph_html = "".join(
        [
            "<div class='flow-shell'>",
            "<div style='text-align:center;'>",
            "<div class='mini-label'>Root Actor</div>",
            f"<div class='flow-root'>{html.escape(trace.root_actor)}</div>",
            "</div>",
            "<div class='flow-divider'>&darr;</div>",
            f"<div class='flow-row'>{''.join(actor_cards)}</div>",
            "</div>",
        ]
    )

    provider_payload_json = _provider_payload_json(events)
    snapshot = _json_dump(
        {
            "run_id": trace.run_id,
            "completed": trace.completed,
            "cancel_requested": trace.cancel_requested,
            "cancel_reason": trace.cancel_reason,
            "filters": {"actor": actor, "kind": kind, "status": status},
            "metrics": trace.metrics.model_dump(mode="json") if trace.metrics else None,
            "latest_provider_payload": json.loads(provider_payload_json) if provider_payload_json != "{}" else {},
            "latest_events": [event.model_dump(mode="json") for event in events[-10:]],
        }
    )

    return (
        summary,
        graph_html,
        _event_rows(events),
        _provider_markdown(events),
        provider_payload_json,
        _tool_inventory_markdown(trace, events, actor, kind, status),
        snapshot,
    )


def _sync_trace_filters(
    trace_state: Any,
    actor_value: str = "all",
    kind_value: str = "all",
    status_value: str = "all",
    preferred_actor: str = "",
):
    trace = _state_to_trace(trace_state)
    actor_choices = _trace_actor_choices(trace)
    kind_choices = _trace_kind_choices(trace)
    status_choices = _trace_status_choices(trace)
    if preferred_actor and preferred_actor in actor_choices and actor_value == "all":
        actor_value = preferred_actor
    actor_value = actor_value if actor_value in actor_choices else "all"
    kind_value = kind_value if kind_value in kind_choices else "all"
    status_value = status_value if status_value in status_choices else "all"
    panels = _render_trace_panels(trace, actor_value, kind_value, status_value)
    return (
        gr.Dropdown(label="Actor Filter", choices=actor_choices, value=actor_value),
        gr.Dropdown(label="Event Kind Filter", choices=kind_choices, value=kind_value),
        gr.Dropdown(label="Status Filter", choices=status_choices, value=status_value),
        *panels,
    )


def _sync_agent_trace_filters(
    trace_state: Any,
    agent_key: str,
    actor_value: str = "all",
    kind_value: str = "all",
    status_value: str = "all",
):
    preferred_actor = _normalize_agent_key(agent_key)
    return _sync_trace_filters(
        trace_state,
        actor_value=actor_value,
        kind_value=kind_value,
        status_value=status_value,
        preferred_actor=preferred_actor,
    )


def _chat_message(role: str, content: str) -> dict[str, str]:
    return {"role": role, "content": content}


def _event_to_chat_message(event: RuntimeEvent) -> dict[str, str]:
    details = event.details or {}
    chips: list[str] = []
    if details.get("provider") or details.get("model_name"):
        chips.append(f"{details.get('provider', 'unknown')} / {details.get('model_name', 'unknown')}")
    if details.get("tool_name"):
        chips.append(f"tool `{details['tool_name']}`")
    if details.get("tool_call_names"):
        chips.append("requested " + ", ".join(f"`{name}`" for name in details["tool_call_names"]))
    if details.get("input_tokens") is not None or details.get("output_tokens") is not None:
        chips.append(f"tokens `{details.get('input_tokens', 0)}` / `{details.get('output_tokens', 0)}`")
    prefix = {"success": "Completed", "warning": "Attention", "error": "Error"}.get(event.status, "Step")
    content = f"**{prefix} | {event.actor}**\n\n{event.message}"
    if chips:
        content += "\n\n_" + " | ".join(chips) + "_"
    if event.kind == "llm_response" and details.get("content_preview"):
        content += f"\n\n```text\n{str(details['content_preview'])[:600]}\n```"
    return _chat_message("assistant", content)


def _new_observer(root_actor: str, url: str) -> RunObserver:
    observer = run_registry.create(
        run_id=str(uuid.uuid4()),
        root_actor=root_actor,
        tracing=get_tracing_status(settings),
    )
    observer.set_url(url)
    observer.emit("run_created", f"Run created for {url}")
    return observer


def _run_async(target: Any, result_holder: dict[str, Any], error_holder: dict[str, Any]) -> None:
    try:
        result_holder["result"] = asyncio.run(target)
    except Exception as exc:  # pragma: no cover - runtime safeguard
        error_holder["error"] = exc


def _poll_run(
    observer: RunObserver,
    worker: threading.Thread,
    chat_history: list[dict[str, str]],
    error_holder: dict[str, Any],
):
    last_seq = 0
    while worker.is_alive() or observer.events_since(last_seq):
        for event in observer.events_since(last_seq):
            chat_history.append(_event_to_chat_message(event))
            last_seq = event.seq
        yield chat_history, observer.trace()
        time.sleep(0.25)

    worker.join()
    if "error" in error_holder:
        error = error_holder["error"]
        if isinstance(error, RunCancelledError):
            if not observer.trace().completed:
                observer.finish(success=False, failure_mode="cancelled")
            chat_history.append(_chat_message("assistant", f"**Cancelled | {observer.actor}**\n\n{error}"))
        else:
            observer.emit("run_failed", str(error), status="error")
            observer.finish(success=False, failure_mode=type(error).__name__)
            chat_history.append(_chat_message("assistant", f"**Error | {observer.actor}**\n\n{error}"))
    yield chat_history, observer.trace()


def _request_stop(run_id: str) -> str:
    run_id = (run_id or "").strip()
    if not run_id:
        return "### Run Control\n_No run ID is available yet._"
    if run_registry.request_cancel(run_id, reason="Stop requested from the Gradio control room."):
        return _run_control_markdown(
            run_registry.get(run_id),
            notice="Stop signal sent. The run will stop at the next safe checkpoint.",
        )
    trace = run_registry.get(run_id)
    if trace is not None:
        return _run_control_markdown(trace, notice="This run is already finished or already cancelling.")
    return "### Run Control\n_Run not found in the active registry._"


def _tracing_markdown() -> str:
    status = get_tracing_status(settings)
    state = "Enabled" if status.enabled else "Disabled"
    key_state = "Configured" if status.api_key_configured else "Missing API key"
    warning_lines = "\n".join(f"- {warning}" for warning in status.warnings) or "- None"
    pricing_models = ", ".join(status.pricing_models) or "none"
    return (
        "### Phoenix Tracing\n"
        f"- Provider: `{status.provider}`\n"
        f"- State: `{state}`\n"
        f"- Deployment: `{status.deployment}`\n"
        f"- API key: `{key_state}`\n"
        f"- Project: `{status.project}`\n"
        f"- Base URL: `{status.base_url}`\n"
        f"- Collector: `{status.endpoint}`\n"
        f"- UI: `{status.ui_url or 'not resolved'}`\n"
        f"- Default dataset: `{status.default_dataset_name}`\n"
        f"- Pricing models: `{pricing_models}`\n"
        f"- Tracing env: `{status.tracing_env}`\n"
        f"- Warnings:\n{warning_lines}"
    )


def _metrics_markdown(metrics: RunMetrics | None) -> str:
    if metrics is None:
        return "### Metrics\n_No metrics recorded yet._"
    agents = ", ".join(agent.value for agent in metrics.agents_invoked) or "none"
    finished_at = metrics.finished_at.isoformat() if metrics.finished_at else "running"
    model_lines = (
        "\n".join(
            f"- `{entry.model_name}` ({entry.provider or 'unknown'}): calls `{entry.llm_calls}`, tokens `{entry.input_tokens}` / `{entry.output_tokens}`, cost `${entry.estimated_total_cost_usd:.6f}`"
            for entry in metrics.model_usage
        )
        or "- None"
    )
    return (
        "### Metrics\n"
        f"- Run ID: `{metrics.run_id}`\n"
        f"- URL: `{metrics.url}`\n"
        f"- Agents invoked: `{agents}`\n"
        f"- LLM calls: `{metrics.total_llm_calls}`\n"
        f"- Tool calls: `{metrics.total_tool_calls}`\n"
        f"- Tokens in/out: `{metrics.total_tokens_in}` / `{metrics.total_tokens_out}`\n"
        f"- Messages: `{metrics.total_messages}` (system `{metrics.system_messages}`, human `{metrics.human_messages}`, ai `{metrics.ai_messages}`, tool `{metrics.tool_messages}`)\n"
        f"- Estimated cost: `${metrics.estimated_total_cost_usd:.6f}`\n"
        f"- Duration: `{metrics.total_duration_seconds:.2f}s`\n"
        f"- Success: `{metrics.success}`\n"
        f"- Failure mode: `{metrics.failure_mode or 'none'}`\n"
        f"- Finished: `{finished_at}`\n"
        f"- Model usage:\n{model_lines}"
    )


def _stream_rows(result: PipelineResult | ExtractionResult | None) -> list[list[str]]:
    streams = getattr(result, "all_streams", None)
    if streams is None and result is not None:
        streams = getattr(result, "streams", [])
    return [
        [stream.url, stream.protocol or "-", stream.quality or "-", stream.source_layer or "-"]
        for stream in (streams or [])
    ]


def _email_markdown(result: PipelineResult | None) -> str:
    if result is None or not result.takedown_emails:
        return "### Takedown Emails\n_No takedown emails generated yet._"
    blocks = []
    for email in result.takedown_emails:
        blocks.append(
            "\n".join(
                [
                    f"#### {email.provider}",
                    f"- To: `{email.abuse_email}`",
                    f"- Subject: `{email.subject}`",
                    f"- Streams: `{len(email.stream_urls)}`",
                ]
            )
        )
    return "### Takedown Emails\n" + "\n\n".join(blocks)


def _pipeline_status_markdown(result: PipelineResult | None, metrics: RunMetrics | None) -> str:
    if result is None:
        return "### Run Summary\n_Waiting for a run._"
    resolved_metrics = metrics or result.metrics
    lines = [
        "### Run Summary",
        f"- Final status: `{result.final_status.value}`",
        f"- Streams found: `{len(result.all_streams)}`",
        f"- Screenshots: `{len(result.all_screenshots)}`",
        f"- Provider analyses: `{len(result.provider_analysis)}`",
        f"- Emails generated: `{len(result.takedown_emails)}`",
    ]
    if resolved_metrics is not None:
        lines.append(f"- Duration: `{resolved_metrics.total_duration_seconds:.2f}s`")
    return "\n".join(lines)


def _test_verdict_markdown(
    agent_key: str,
    result: ClassificationResult | ExtractionResult | None,
    expected_page_type: str,
    expected_status: str,
    min_streams: int,
) -> str:
    if result is None:
        return "### Test Verdict\n_No result yet._"
    checks: list[tuple[str, bool, str]] = []
    if isinstance(result, ClassificationResult):
        if expected_page_type and expected_page_type != "any":
            checks.append(
                (
                    "Page type",
                    result.page_type.value == expected_page_type,
                    f"expected `{expected_page_type}` vs actual `{result.page_type.value}`",
                )
            )
    else:
        if expected_status and expected_status != "any":
            checks.append(
                (
                    "Extraction status",
                    result.status.value == expected_status,
                    f"expected `{expected_status}` vs actual `{result.status.value}`",
                )
            )
        checks.append(
            (
                "Minimum streams",
                len(result.streams) >= min_streams,
                f"expected at least `{min_streams}` vs actual `{len(result.streams)}`",
            )
        )
    if not checks:
        return f"### Test Verdict\n`{agent_key}` executed without explicit assertions."
    passed = all(item[1] for item in checks)
    lines = [f"### Test Verdict\n`{'PASS' if passed else 'FAIL'}` for `{agent_key}`"]
    for label, ok, detail in checks:
        lines.append(f"- {label}: `{'PASS' if ok else 'FAIL'}` ({detail})")
    return "\n".join(lines)


async def _run_selected_agent(agent_key: str, url: str, observer: RunObserver):
    agent_key = _normalize_agent_key(agent_key)
    if agent_key == "classification":
        return await ClassificationAgent(settings).run(url=url, observer=observer)
    if agent_key == "landing":
        return await LandingPageAgent(settings).run(url=url, observer=observer)
    if agent_key == "hosting":
        return await HostingPageAgent(settings).run(url=url, observer=observer)
    if agent_key == "embedded":
        return await EmbeddedPageAgent(settings).run(url=url, observer=observer)
    raise ValueError(f"Unknown agent '{agent_key}'")


def _run_pipeline_stream(url: str):
    empty_panels = _render_trace_panels(None)
    if not url.strip():
        yield (
            [],
            "### Run Summary\nPlease provide a URL.",
            "{}",
            [],
            "### Takedown Emails\n_No run yet._",
            "### Metrics\n_No metrics recorded yet._",
            _tracing_markdown(),
            "",
            "### Run Control\n_No active run._",
            *empty_panels,
            {},
        )
        return

    observer = _new_observer("orchestrator", url.strip())
    chat_history = [
        _chat_message("user", f"Run the orchestrator for `{url.strip()}`."),
        _chat_message(
            "assistant",
            "Preparing the orchestrator, sub-agents, tools, live graph, and provider views.",
        ),
    ]
    result_holder: dict[str, Any] = {}
    error_holder: dict[str, Any] = {}
    worker = threading.Thread(
        target=_run_async,
        args=(run_pipeline(url=url.strip(), settings=settings, observer=observer), result_holder, error_holder),
        daemon=True,
    )
    worker.start()

    for chat, trace in _poll_run(observer, worker, chat_history, error_holder):
        result = result_holder.get("result")
        yield (
            chat,
            _pipeline_status_markdown(result, trace.metrics),
            _json_dump(result),
            _stream_rows(result),
            _email_markdown(result),
            _metrics_markdown(trace.metrics),
            _tracing_markdown(),
            observer.run_id,
            _run_control_markdown(trace),
            *_render_trace_panels(trace),
            _trace_to_state(trace),
        )


def _run_agent_test_stream(
    agent_key: str,
    url: str,
    expected_page_type: str,
    expected_status: str,
    min_streams: int,
):
    empty_panels = _render_trace_panels(None)
    agent_key = _normalize_agent_key(agent_key)
    if not url.strip():
        yield (
            [],
            "### Test Verdict\nPlease provide a URL.",
            "{}",
            "### Metrics\n_No metrics recorded yet._",
            _tracing_markdown(),
            "",
            "### Run Control\n_No active run._",
            *empty_panels,
            {},
        )
        return

    observer = _new_observer(agent_key, url.strip())
    chat_history = [
        _chat_message("user", f"Run the `{agent_key}` agent as a test for `{url.strip()}`."),
        _chat_message(
            "assistant",
            "Launching the selected agent and streaming every meaningful step into the dashboard.",
        ),
    ]
    result_holder: dict[str, Any] = {}
    error_holder: dict[str, Any] = {}
    worker = threading.Thread(
        target=_run_async,
        args=(_run_selected_agent(agent_key, url.strip(), observer), result_holder, error_holder),
        daemon=True,
    )
    worker.start()

    for chat, trace in _poll_run(observer, worker, chat_history, error_holder):
        result = result_holder.get("result")
        if result is not None and not trace.completed:
            success = True
            failure_mode = ""
            if isinstance(result, ExtractionResult) and result.status != ExtractionStatus.SUCCESS:
                success = result.status in {ExtractionStatus.SUCCESS, ExtractionStatus.PARTIAL}
                failure_mode = "" if success else result.status.value
            observer.finish(success=success, failure_mode=failure_mode)
            trace = observer.trace()
        yield (
            chat,
            _test_verdict_markdown(agent_key, result, expected_page_type, expected_status, min_streams),
            _json_dump(result),
            _metrics_markdown(trace.metrics),
            _tracing_markdown(),
            observer.run_id,
            _run_control_markdown(trace),
            *_render_trace_panels(trace),
            _trace_to_state(trace),
        )


def _refresh_observability():
    session = get_session()
    try:
        repo = RunRepository(session)
        recent = repo.list_recent(limit=15)
        run_rows = [
            [
                record.run_id,
                record.status,
                record.streams_found,
                record.tool_calls,
                record.tokens_in,
                record.tokens_out,
                ((record.result_json or {}).get("metrics") or {}).get("total_llm_calls", 0),
                ((record.result_json or {}).get("metrics") or {}).get("estimated_total_cost_usd", 0.0),
                round(record.duration_seconds or 0.0, 2),
                record.created_at.isoformat(),
            ]
            for record in recent
        ]
        traces = run_registry.list_recent(limit=20)
        trace_rows = [
            [
                trace.run_id,
                trace.root_actor,
                len(trace.events),
                trace.metrics.total_tool_calls if trace.metrics else 0,
                trace.metrics.total_llm_calls if trace.metrics else 0,
                trace.cancel_requested,
                trace.completed,
                trace.started_at.isoformat(),
            ]
            for trace in traces
        ]
        choices = [("Select a run", "")]
        for trace in traces:
            choices.append((f"{trace.root_actor} | {trace.run_id}", trace.run_id))
        summary = {
            "tracing": get_tracing_status(settings).model_dump(mode="json"),
            "database_success_rate": repo.success_rate(),
            "recent_run_count": len(run_rows),
            "active_trace_count": len(trace_rows),
        }
        return (
            _tracing_markdown(),
            run_rows,
            trace_rows,
            _json_dump(summary),
            gr.Dropdown(label="Inspect Active Trace", choices=choices, value=""),
        )
    finally:
        session.close()


def _load_observability_trace(run_id: str):
    trace = run_registry.get((run_id or "").strip()) if (run_id or "").strip() else None
    return _trace_to_state(trace), _run_control_markdown(trace), *_sync_trace_filters(_trace_to_state(trace))


def _agent_choice_updates(agent_key: str):
    agent_key = _normalize_agent_key(agent_key)
    is_classification = agent_key == "classification"
    note = "\n".join(
        [
            "### Agent Focus",
            f"- Selected agent: `{_agent_label(agent_key)}`",
            f"- Recommended actor filter: `{agent_key}`",
            f"- Assertions enabled: `{'page type' if is_classification else 'status and stream count'}`",
            "- The filtered trace view will stay centered on this actor unless you change it.",
        ]
    )
    return (
        gr.Dropdown(
            label="Expected Page Type",
            choices=PAGE_TYPE_OPTIONS,
            value="any",
            interactive=is_classification,
        ),
        gr.Dropdown(
            label="Expected Extraction Status",
            choices=STATUS_OPTIONS,
            value="any",
            interactive=not is_classification,
        ),
        gr.Slider(
            label="Minimum Streams",
            minimum=0,
            maximum=10,
            step=1,
            value=0,
            interactive=not is_classification,
        ),
        gr.Dropdown(label="Actor Filter", choices=["all", agent_key], value=agent_key),
        note,
    )


def _dataset_example_rows(examples: list[Any]) -> list[list[Any]]:
    rows: list[list[Any]] = []
    for example in examples:
        output = example.output or {}
        metadata = example.metadata or {}
        rows.append(
            [
                example.input.get("url", ""),
                output.get("final_status", ""),
                len(output.get("stream_urls", [])),
                ", ".join(output.get("provider_names", [])) or "-",
                metadata.get("success", False),
                metadata.get("llm_calls", 0),
                metadata.get("tool_calls", 0),
                round(float(metadata.get("estimated_total_cost_usd", 0.0) or 0.0), 6),
            ]
        )
    return rows


def _load_dataset_examples(limit: int, dataset_name: str):
    resolved_limit = max(int(limit or 1), 1)
    session = get_session()
    try:
        repo = RunRepository(session)
        records = repo.list_recent(limit=resolved_limit)
        results: list[PipelineResult] = []
        skipped = 0
        for record in records:
            if not record.result_json:
                skipped += 1
                continue
            try:
                results.append(PipelineResult.model_validate(record.result_json))
            except Exception:
                skipped += 1

        examples = build_dataset_examples(results)
        status = "\n".join(
            [
                "### Dataset Preview",
                f"- Requested runs: `{resolved_limit}`",
                f"- Valid examples: `{len(examples)}`",
                f"- Skipped runs: `{skipped}`",
                f"- Target dataset: `{dataset_name or get_tracing_status(settings).default_dataset_name}`",
            ]
        )
        preview_payload = {
            "dataset_name": dataset_name or get_tracing_status(settings).default_dataset_name,
            "example_count": len(examples),
            "examples": [example.model_dump(mode="json") for example in examples[:5]],
        }
        return status, _dataset_example_rows(examples), _json_dump(preview_payload)
    finally:
        session.close()


def _export_dataset_ui(
    limit: int,
    dataset_name: str,
    path: str,
    upload_to_phoenix: bool,
    dataset_description: str,
):
    status, rows, preview_json = _load_dataset_examples(limit, dataset_name)
    preview_payload = json.loads(preview_json)
    examples_payload = preview_payload.get("examples", [])
    if not rows:
        result_payload = {"ok": False, "message": "No valid examples were available to export."}
        return status, _json_dump(result_payload), rows, preview_json

    session = get_session()
    try:
        records = RunRepository(session).list_recent(limit=max(int(limit or 1), 1))
        results: list[PipelineResult] = []
        for record in records:
            if not record.result_json:
                continue
            try:
                results.append(PipelineResult.model_validate(record.result_json))
            except Exception:
                continue
        examples = build_dataset_examples(results)
    finally:
        session.close()

    export_path = export_dataset_examples(
        examples,
        settings=settings,
        dataset_name=dataset_name,
        path=path or None,
    )
    result_payload: dict[str, Any] = {
        "ok": True,
        "path": str(export_path),
        "dataset_name": dataset_name or get_tracing_status(settings).default_dataset_name,
        "example_count": len(examples),
        "uploaded": False,
        "preview_examples_in_panel": len(examples_payload),
    }
    if upload_to_phoenix:
        try:
            result_payload["phoenix"] = publish_dataset_to_phoenix(
                examples,
                settings=settings,
                dataset_name=dataset_name,
                dataset_description=dataset_description,
            )
            result_payload["uploaded"] = True
        except Exception as exc:
            result_payload["uploaded"] = False
            result_payload["phoenix_error"] = str(exc)
    return status, _json_dump(result_payload), rows, preview_json


def build_ui() -> gr.Blocks:
    with gr.Blocks(title="Open Web Catcher Control Room") as demo:
        with gr.Column(elem_classes=["app-shell"]):
            gr.HTML(
                """
                <div class="hero">
                  <h1>Open Web Catcher Control Room</h1>
                  <p>
                    Watch the orchestrator and specialist agents step through a run in plain language,
                    see which agent and tool are active, inspect provider payloads, stop runs at safe
                    checkpoints, and curate Phoenix-ready datasets without leaving the dashboard.
                  </p>
                </div>
                """
            )

            with gr.Tab("Live Pipeline"):
                pipeline_trace_state = gr.State({})
                gr.Markdown(
                    "<div class='panel-note'>The orchestrator tab keeps the whole run visible: current actor, live graph, tool ledger, provider payload, final streams, and takedown outputs.</div>"
                )
                with gr.Row():
                    url_in = gr.Textbox(
                        label="Target URL",
                        placeholder="https://example-streaming-site.com/watch/123",
                        scale=4,
                    )
                    pipeline_run_id = gr.Textbox(label="Run ID", interactive=False, scale=2)
                    run_btn = gr.Button("Run Orchestrator", variant="primary", scale=1)
                    stop_btn = gr.Button("Stop Run", variant="stop", scale=1)
                with gr.Row():
                    with gr.Column(scale=7):
                        pipeline_chat = gr.Chatbot(label="Live Console", height=460, type="messages")
                    with gr.Column(scale=5):
                        pipeline_control = gr.Markdown("### Run Control\n_No active run._", elem_classes=["run-card"])
                        pipeline_status = gr.Markdown("### Run Summary\n_Waiting for a run._", elem_classes=["run-card"])
                        pipeline_metrics = gr.Markdown("### Metrics\n_No metrics recorded yet._", elem_classes=["run-card"])
                        pipeline_tracing = gr.Markdown(_tracing_markdown(), elem_classes=["status-card"])
                with gr.Row():
                    pipeline_live_summary = gr.Markdown("### Live Activity\n_No trace yet._", elem_classes=["run-card"])
                    pipeline_live_inventory = gr.Markdown(
                        "### Agent and Tool Inventory\n_No trace yet._",
                        elem_classes=["run-card"],
                    )
                pipeline_live_graph = gr.HTML(_render_trace_panels(None)[1])
                with gr.Row():
                    pipeline_live_events = gr.Dataframe(
                        headers=EVENT_HEADERS,
                        label="Live Event Table",
                        row_count=10,
                        col_count=(10, "fixed"),
                        scale=7,
                    )
                    with gr.Column(scale=5):
                        pipeline_live_provider = gr.Markdown("### Provider Feed\n_No provider responses yet._")
                        pipeline_live_provider_json = gr.Code(label="Provider Payload", language="json", value="{}")
                        pipeline_live_snapshot = gr.Code(label="Trace Snapshot", language="json", value="{}")
                with gr.Accordion("Filtered Trace View", open=False):
                    with gr.Row():
                        pipeline_actor_filter = gr.Dropdown(label="Actor Filter", choices=["all"], value="all")
                        pipeline_kind_filter = gr.Dropdown(label="Event Kind Filter", choices=["all"], value="all")
                        pipeline_status_filter = gr.Dropdown(label="Status Filter", choices=["all"], value="all")
                    with gr.Row():
                        pipeline_sync_filters = gr.Button("Load Filters From Current Trace")
                        pipeline_apply_filters = gr.Button("Apply Filters", variant="secondary")
                    with gr.Row():
                        pipeline_filtered_summary = gr.Markdown(
                            "### Live Activity\n_No filtered view yet._",
                            elem_classes=["run-card"],
                        )
                        pipeline_filtered_inventory = gr.Markdown(
                            "### Agent and Tool Inventory\n_No filtered view yet._",
                            elem_classes=["run-card"],
                        )
                    pipeline_filtered_graph = gr.HTML(_render_trace_panels(None)[1])
                    with gr.Row():
                        pipeline_filtered_events = gr.Dataframe(
                            headers=EVENT_HEADERS,
                            label="Filtered Event Table",
                            row_count=10,
                            col_count=(10, "fixed"),
                            scale=7,
                        )
                        with gr.Column(scale=5):
                            pipeline_filtered_provider = gr.Markdown("### Provider Feed\n_No provider responses yet._")
                            pipeline_filtered_provider_json = gr.Code(
                                label="Filtered Provider Payload",
                                language="json",
                                value="{}",
                            )
                            pipeline_filtered_snapshot = gr.Code(
                                label="Filtered Snapshot",
                                language="json",
                                value="{}",
                            )
                with gr.Accordion("Outputs", open=False):
                    pipeline_streams = gr.Dataframe(
                        headers=["URL", "Protocol", "Quality", "Source"],
                        label="Streams",
                        row_count=6,
                        col_count=(4, "fixed"),
                    )
                    pipeline_result = gr.Code(label="Pipeline Result (JSON)", language="json", value="{}")
                    pipeline_emails = gr.Markdown("### Takedown Emails\n_No run yet._")

                run_btn.click(
                    _run_pipeline_stream,
                    inputs=[url_in],
                    outputs=[
                        pipeline_chat,
                        pipeline_status,
                        pipeline_result,
                        pipeline_streams,
                        pipeline_emails,
                        pipeline_metrics,
                        pipeline_tracing,
                        pipeline_run_id,
                        pipeline_control,
                        pipeline_live_summary,
                        pipeline_live_graph,
                        pipeline_live_events,
                        pipeline_live_provider,
                        pipeline_live_provider_json,
                        pipeline_live_inventory,
                        pipeline_live_snapshot,
                        pipeline_trace_state,
                    ],
                )
                stop_btn.click(_request_stop, inputs=[pipeline_run_id], outputs=[pipeline_control], queue=False)
                pipeline_trace_state.change(
                    _sync_trace_filters,
                    inputs=[pipeline_trace_state, pipeline_actor_filter, pipeline_kind_filter, pipeline_status_filter],
                    outputs=[
                        pipeline_actor_filter,
                        pipeline_kind_filter,
                        pipeline_status_filter,
                        pipeline_filtered_summary,
                        pipeline_filtered_graph,
                        pipeline_filtered_events,
                        pipeline_filtered_provider,
                        pipeline_filtered_provider_json,
                        pipeline_filtered_inventory,
                        pipeline_filtered_snapshot,
                    ],
                    queue=False,
                )
                pipeline_sync_filters.click(
                    _sync_trace_filters,
                    inputs=[pipeline_trace_state, pipeline_actor_filter, pipeline_kind_filter, pipeline_status_filter],
                    outputs=[
                        pipeline_actor_filter,
                        pipeline_kind_filter,
                        pipeline_status_filter,
                        pipeline_filtered_summary,
                        pipeline_filtered_graph,
                        pipeline_filtered_events,
                        pipeline_filtered_provider,
                        pipeline_filtered_provider_json,
                        pipeline_filtered_inventory,
                        pipeline_filtered_snapshot,
                    ],
                    queue=False,
                )
                pipeline_apply_filters.click(
                    _render_trace_panels,
                    inputs=[pipeline_trace_state, pipeline_actor_filter, pipeline_kind_filter, pipeline_status_filter],
                    outputs=[
                        pipeline_filtered_summary,
                        pipeline_filtered_graph,
                        pipeline_filtered_events,
                        pipeline_filtered_provider,
                        pipeline_filtered_provider_json,
                        pipeline_filtered_inventory,
                        pipeline_filtered_snapshot,
                    ],
                    queue=False,
                )

            with gr.Tab("Agent Test Lab"):
                agent_trace_state = gr.State({})
                gr.Markdown(
                    "<div class='panel-note'>Run one specialist agent at a time, keep the trace focused on that actor, compare expectations against the result, and inspect the raw provider payloads that drove the decision.</div>"
                )
                agent_focus = gr.Markdown(
                    "\n".join(
                        [
                            "### Agent Focus",
                            "- Selected agent: `Classification`",
                            "- Recommended actor filter: `classification`",
                            "- Assertions enabled: `page type`",
                            "- The filtered trace view will stay centered on this actor unless you change it.",
                        ]
                    ),
                    elem_classes=["run-card"],
                )
                with gr.Row():
                    agent_choice = gr.Dropdown(label="Agent", choices=AGENT_OPTIONS, value="classification", scale=2)
                    agent_url = gr.Textbox(label="URL Under Test", placeholder="https://example.com", scale=4)
                    agent_run_id = gr.Textbox(label="Run ID", interactive=False, scale=2)
                    agent_run_btn = gr.Button("Run Agent Test", variant="primary", scale=1)
                    agent_stop_btn = gr.Button("Stop Run", variant="stop", scale=1)
                with gr.Row():
                    expected_page_type = gr.Dropdown(
                        label="Expected Page Type",
                        choices=PAGE_TYPE_OPTIONS,
                        value="any",
                        interactive=True,
                    )
                    expected_status = gr.Dropdown(
                        label="Expected Extraction Status",
                        choices=STATUS_OPTIONS,
                        value="any",
                        interactive=False,
                    )
                    min_streams = gr.Slider(
                        label="Minimum Streams",
                        minimum=0,
                        maximum=10,
                        step=1,
                        value=0,
                        interactive=False,
                    )
                with gr.Row():
                    with gr.Column(scale=7):
                        agent_chat = gr.Chatbot(label="Agent Console", height=440, type="messages")
                    with gr.Column(scale=5):
                        agent_control = gr.Markdown("### Run Control\n_No active run._", elem_classes=["run-card"])
                        verdict_md = gr.Markdown("### Test Verdict\n_No test yet._", elem_classes=["run-card"])
                        agent_metrics = gr.Markdown("### Metrics\n_No metrics recorded yet._", elem_classes=["run-card"])
                        agent_tracing = gr.Markdown(_tracing_markdown(), elem_classes=["status-card"])
                with gr.Row():
                    agent_live_summary = gr.Markdown("### Live Activity\n_No trace yet._", elem_classes=["run-card"])
                    agent_live_inventory = gr.Markdown(
                        "### Agent and Tool Inventory\n_No trace yet._",
                        elem_classes=["run-card"],
                    )
                agent_live_graph = gr.HTML(_render_trace_panels(None)[1])
                with gr.Row():
                    agent_live_events = gr.Dataframe(
                        headers=EVENT_HEADERS,
                        label="Live Event Table",
                        row_count=10,
                        col_count=(10, "fixed"),
                        scale=7,
                    )
                    with gr.Column(scale=5):
                        agent_live_provider = gr.Markdown("### Provider Feed\n_No provider responses yet._")
                        agent_live_provider_json = gr.Code(label="Provider Payload", language="json", value="{}")
                        agent_live_snapshot = gr.Code(label="Trace Snapshot", language="json", value="{}")
                with gr.Accordion("Filtered Trace View", open=False):
                    with gr.Row():
                        agent_actor_filter = gr.Dropdown(
                            label="Actor Filter",
                            choices=["all", "classification"],
                            value="classification",
                        )
                        agent_kind_filter = gr.Dropdown(label="Event Kind Filter", choices=["all"], value="all")
                        agent_status_filter = gr.Dropdown(label="Status Filter", choices=["all"], value="all")
                    with gr.Row():
                        agent_sync_filters = gr.Button("Load Filters From Current Trace")
                        agent_apply_filters = gr.Button("Apply Filters", variant="secondary")
                    with gr.Row():
                        agent_filtered_summary = gr.Markdown(
                            "### Live Activity\n_No filtered view yet._",
                            elem_classes=["run-card"],
                        )
                        agent_filtered_inventory = gr.Markdown(
                            "### Agent and Tool Inventory\n_No filtered view yet._",
                            elem_classes=["run-card"],
                        )
                    agent_filtered_graph = gr.HTML(_render_trace_panels(None)[1])
                    with gr.Row():
                        agent_filtered_events = gr.Dataframe(
                            headers=EVENT_HEADERS,
                            label="Filtered Event Table",
                            row_count=10,
                            col_count=(10, "fixed"),
                            scale=7,
                        )
                        with gr.Column(scale=5):
                            agent_filtered_provider = gr.Markdown("### Provider Feed\n_No provider responses yet._")
                            agent_filtered_provider_json = gr.Code(
                                label="Filtered Provider Payload",
                                language="json",
                                value="{}",
                            )
                            agent_filtered_snapshot = gr.Code(
                                label="Filtered Snapshot",
                                language="json",
                                value="{}",
                            )
                agent_result = gr.Code(label="Agent Result (JSON)", language="json", value="{}")

                agent_choice.change(
                    _agent_choice_updates,
                    inputs=[agent_choice],
                    outputs=[expected_page_type, expected_status, min_streams, agent_actor_filter, agent_focus],
                    queue=False,
                )
                agent_run_btn.click(
                    _run_agent_test_stream,
                    inputs=[agent_choice, agent_url, expected_page_type, expected_status, min_streams],
                    outputs=[
                        agent_chat,
                        verdict_md,
                        agent_result,
                        agent_metrics,
                        agent_tracing,
                        agent_run_id,
                        agent_control,
                        agent_live_summary,
                        agent_live_graph,
                        agent_live_events,
                        agent_live_provider,
                        agent_live_provider_json,
                        agent_live_inventory,
                        agent_live_snapshot,
                        agent_trace_state,
                    ],
                )
                agent_stop_btn.click(_request_stop, inputs=[agent_run_id], outputs=[agent_control], queue=False)
                agent_trace_state.change(
                    _sync_agent_trace_filters,
                    inputs=[agent_trace_state, agent_choice, agent_actor_filter, agent_kind_filter, agent_status_filter],
                    outputs=[
                        agent_actor_filter,
                        agent_kind_filter,
                        agent_status_filter,
                        agent_filtered_summary,
                        agent_filtered_graph,
                        agent_filtered_events,
                        agent_filtered_provider,
                        agent_filtered_provider_json,
                        agent_filtered_inventory,
                        agent_filtered_snapshot,
                    ],
                    queue=False,
                )
                agent_sync_filters.click(
                    _sync_agent_trace_filters,
                    inputs=[agent_trace_state, agent_choice, agent_actor_filter, agent_kind_filter, agent_status_filter],
                    outputs=[
                        agent_actor_filter,
                        agent_kind_filter,
                        agent_status_filter,
                        agent_filtered_summary,
                        agent_filtered_graph,
                        agent_filtered_events,
                        agent_filtered_provider,
                        agent_filtered_provider_json,
                        agent_filtered_inventory,
                        agent_filtered_snapshot,
                    ],
                    queue=False,
                )
                agent_apply_filters.click(
                    _render_trace_panels,
                    inputs=[agent_trace_state, agent_actor_filter, agent_kind_filter, agent_status_filter],
                    outputs=[
                        agent_filtered_summary,
                        agent_filtered_graph,
                        agent_filtered_events,
                        agent_filtered_provider,
                        agent_filtered_provider_json,
                        agent_filtered_inventory,
                        agent_filtered_snapshot,
                    ],
                    queue=False,
                )

            with gr.Tab("Observability"):
                obs_trace_state = gr.State({})
                gr.Markdown(
                    "<div class='status-card'>Review recent persisted runs, inspect active traces, filter events by actor or kind, and stop a live run directly from the observability workspace.</div>"
                )
                with gr.Row():
                    refresh_btn = gr.Button("Refresh Observability", variant="secondary")
                    obs_trace_selector = gr.Dropdown(label="Inspect Active Trace", choices=[("Select a run", "")], value="")
                    obs_stop_btn = gr.Button("Stop Selected Trace", variant="stop")
                with gr.Row():
                    with gr.Column(scale=4):
                        obs_tracing = gr.Markdown(_tracing_markdown())
                    with gr.Column(scale=8):
                        obs_summary = gr.Code(label="Observability Snapshot", language="json", value="{}")
                recent_runs = gr.Dataframe(
                    headers=[
                        "Run ID",
                        "Status",
                        "Streams",
                        "Tool Calls",
                        "Tokens In",
                        "Tokens Out",
                        "LLM Calls",
                        "Cost",
                        "Seconds",
                        "Created At",
                    ],
                    label="Recent Persisted Runs",
                    row_count=12,
                    col_count=(10, "fixed"),
                )
                active_traces = gr.Dataframe(
                    headers=[
                        "Run ID",
                        "Actor",
                        "Events",
                        "Tool Calls",
                        "LLM Calls",
                        "Cancelling",
                        "Completed",
                        "Started At",
                    ],
                    label="Active / In-Memory Traces",
                    row_count=12,
                    col_count=(8, "fixed"),
                )
                obs_control = gr.Markdown(
                    "### Run Control\n_Select an active trace to inspect or stop it._",
                    elem_classes=["run-card"],
                )
                with gr.Row():
                    obs_actor_filter = gr.Dropdown(label="Actor Filter", choices=["all"], value="all")
                    obs_kind_filter = gr.Dropdown(label="Event Kind Filter", choices=["all"], value="all")
                    obs_status_filter = gr.Dropdown(label="Status Filter", choices=["all"], value="all")
                with gr.Row():
                    obs_sync_filters = gr.Button("Load Filters From Selected Trace")
                    obs_apply_filters = gr.Button("Apply Filters", variant="secondary")
                with gr.Row():
                    obs_trace_summary = gr.Markdown("### Live Activity\n_No trace selected._", elem_classes=["run-card"])
                    obs_trace_inventory = gr.Markdown(
                        "### Agent and Tool Inventory\n_No trace selected._",
                        elem_classes=["run-card"],
                    )
                obs_trace_graph = gr.HTML(_render_trace_panels(None)[1])
                with gr.Row():
                    obs_trace_events = gr.Dataframe(
                        headers=EVENT_HEADERS,
                        label="Trace Event Table",
                        row_count=12,
                        col_count=(10, "fixed"),
                        scale=7,
                    )
                    with gr.Column(scale=5):
                        obs_trace_provider = gr.Markdown("### Provider Feed\n_No provider responses yet._")
                        obs_trace_provider_json = gr.Code(label="Provider Payload", language="json", value="{}")
                        obs_trace_snapshot = gr.Code(label="Trace Snapshot", language="json", value="{}")

                refresh_btn.click(
                    _refresh_observability,
                    outputs=[obs_tracing, recent_runs, active_traces, obs_summary, obs_trace_selector],
                    queue=False,
                )
                obs_trace_selector.change(
                    _load_observability_trace,
                    inputs=[obs_trace_selector],
                    outputs=[
                        obs_trace_state,
                        obs_control,
                        obs_actor_filter,
                        obs_kind_filter,
                        obs_status_filter,
                        obs_trace_summary,
                        obs_trace_graph,
                        obs_trace_events,
                        obs_trace_provider,
                        obs_trace_provider_json,
                        obs_trace_inventory,
                        obs_trace_snapshot,
                    ],
                    queue=False,
                )
                obs_stop_btn.click(_request_stop, inputs=[obs_trace_selector], outputs=[obs_control], queue=False)
                obs_sync_filters.click(
                    _sync_trace_filters,
                    inputs=[obs_trace_state, obs_actor_filter, obs_kind_filter, obs_status_filter],
                    outputs=[
                        obs_actor_filter,
                        obs_kind_filter,
                        obs_status_filter,
                        obs_trace_summary,
                        obs_trace_graph,
                        obs_trace_events,
                        obs_trace_provider,
                        obs_trace_provider_json,
                        obs_trace_inventory,
                        obs_trace_snapshot,
                    ],
                    queue=False,
                )
                obs_apply_filters.click(
                    _render_trace_panels,
                    inputs=[obs_trace_state, obs_actor_filter, obs_kind_filter, obs_status_filter],
                    outputs=[
                        obs_trace_summary,
                        obs_trace_graph,
                        obs_trace_events,
                        obs_trace_provider,
                        obs_trace_provider_json,
                        obs_trace_inventory,
                        obs_trace_snapshot,
                    ],
                    queue=False,
                )

            with gr.Tab("Dataset Studio"):
                gr.Markdown(
                    "<div class='panel-note'>Preview recent successful and failed runs as Phoenix-friendly examples, export them to JSONL, and optionally publish them into your Phoenix instance when the client is configured.</div>"
                )
                with gr.Row():
                    dataset_limit = gr.Slider(label="Recent Runs To Scan", minimum=1, maximum=50, step=1, value=10)
                    dataset_name = gr.Textbox(label="Dataset Name", placeholder="leave blank to use the Phoenix default")
                    upload_to_phoenix = gr.Checkbox(label="Upload To Phoenix", value=False)
                dataset_path = gr.Textbox(label="Export Path (optional)", placeholder="data/datasets/my-dataset.jsonl")
                dataset_description = gr.Textbox(
                    label="Dataset Description",
                    lines=3,
                    placeholder="Optional description for Phoenix dataset uploads.",
                )
                with gr.Row():
                    preview_dataset_btn = gr.Button("Preview Examples", variant="secondary")
                    export_dataset_btn = gr.Button("Export Dataset", variant="primary")
                with gr.Row():
                    dataset_status = gr.Markdown("### Dataset Preview\n_No dataset preview yet._", elem_classes=["run-card"])
                    dataset_tracing = gr.Markdown(_tracing_markdown(), elem_classes=["status-card"])
                dataset_rows = gr.Dataframe(
                    headers=DATASET_HEADERS,
                    label="Dataset Example Table",
                    row_count=10,
                    col_count=(8, "fixed"),
                )
                with gr.Row():
                    dataset_preview = gr.Code(label="Dataset Preview (JSON)", language="json", value="{}")
                    dataset_export_result = gr.Code(label="Export Result", language="json", value="{}")

                preview_dataset_btn.click(
                    _load_dataset_examples,
                    inputs=[dataset_limit, dataset_name],
                    outputs=[dataset_status, dataset_rows, dataset_preview],
                    queue=False,
                )
                export_dataset_btn.click(
                    _export_dataset_ui,
                    inputs=[dataset_limit, dataset_name, dataset_path, upload_to_phoenix, dataset_description],
                    outputs=[dataset_status, dataset_export_result, dataset_rows, dataset_preview],
                )

            demo.load(
                _refresh_observability,
                outputs=[obs_tracing, recent_runs, active_traces, obs_summary, obs_trace_selector],
                queue=False,
            )
            demo.load(
                _load_dataset_examples,
                inputs=[dataset_limit, dataset_name],
                outputs=[dataset_status, dataset_rows, dataset_preview],
                queue=False,
            )
    return demo


def launch(server_name: str = "0.0.0.0", server_port: int = 7860) -> None:
    setup_logging(level=settings.log_level, log_file=settings.log_file)
    setup_tracing_from_settings(settings)
    logger.info("Starting Gradio dashboard on %s:%s", server_name, server_port)
    build_ui().queue(default_concurrency_limit=4).launch(
        server_name=server_name,
        server_port=server_port,
        css=APP_CSS,
        theme=gr.themes.Soft(),
    )


if __name__ == "__main__":
    launch()
