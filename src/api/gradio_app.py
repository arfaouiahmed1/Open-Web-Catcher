"""Interactive Gradio dashboard for live runs, control, observability, and datasets."""

from __future__ import annotations

import asyncio
from collections import Counter
import html
import json
import os
import threading
import time
import uuid
from typing import Any

import gradio as gr

from src.api.gradio.layout import (
    build_agent_test_lab_tab,
    build_dataset_studio_tab,
    build_live_pipeline_tab,
    build_observability_tab,
    build_quality_lab_tab,
)
from src.api.gradio.quality import (
    default_pytest_targets,
    discover_pytest_targets,
    load_tool_catalog,
    quality_mode_updates,
    run_quality_task,
)
from src.api.gradio.shared import (
    AGENT_LABELS,
    APP_CSS,
    DEFAULT_QUEUE_CONCURRENCY_LIMIT,
    PAGE_TYPE_OPTIONS,
    STATUS_OPTIONS,
)
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


def _latest_tool_event(events: list[RuntimeEvent]) -> RuntimeEvent | None:
    for event in reversed(events):
        if event.kind in {"tool_call_started", "tool_call_finished"}:
            return event
    return None


def _trim_preview(value: Any, limit: int = 220) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _tool_target_summary(tool_name: str, tool_args: dict[str, Any] | None) -> str:
    args = tool_args or {}
    if not args:
        return "no explicit target"

    named_keys = [
        "url",
        "mainUrl",
        "player_iframe_url",
        "player_iframe_hint",
        "selector",
        "kind",
        "action",
        "value",
        "text",
        "query",
        "server",
        "base_url",
    ]
    parts: list[str] = []
    for key in named_keys:
        if key in args and args.get(key) not in (None, "", [], {}):
            parts.append(f"{key}={_trim_preview(args.get(key), 90)}")

    if "stream_urls" in args and isinstance(args["stream_urls"], list):
        parts.append(f"stream_urls={len(args['stream_urls'])}")
    if "x" in args or "y" in args:
        x = args.get("x", "?")
        y = args.get("y", "?")
        parts.append(f"coords=({x}, {y})")

    if not parts:
        fallback_items = list(args.items())[:3]
        parts = [f"{key}={_trim_preview(value, 80)}" for key, value in fallback_items]

    return "; ".join(parts) if parts else f"{tool_name} with structured args"


def _tool_call_request_lines(tool_calls_payload: Any, limit: int = 4) -> list[str]:
    if not isinstance(tool_calls_payload, list):
        return []

    lines: list[str] = []
    for call in tool_calls_payload[:limit]:
        tool_name = str(call.get("name", "unknown") or "unknown")
        target = _tool_target_summary(tool_name, call.get("args", {}))
        lines.append(f"- `{tool_name}` on `{target}`")
    return lines


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
        tool_request_lines = _tool_call_request_lines(details.get("tool_calls_payload"))
        blocks.extend(
            [
                f"#### Turn #{event.seq} | {event.actor}",
                f"- Status: `{event.status}`",
                f"- Model: `{details.get('provider', 'unknown')}` / `{details.get('model_name', 'unknown')}`",
                f"- Tokens in/out: `{details.get('input_tokens', 0)}` / `{details.get('output_tokens', 0)}`",
                f"- Requested tools: `{requested_tools}`",
            ]
        )
        if tool_request_lines:
            blocks.extend(["- Requested tool targets:"])
            blocks.extend(tool_request_lines)
        blocks.extend(
            [
                "- Visible model output:",
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
    latest_tool_event = _latest_tool_event(events) or _latest_tool_event(trace.events)
    latest_tool = "none"
    latest_tool_target = "none"
    if latest_tool_event is not None:
        latest_tool = str((latest_tool_event.details or {}).get("tool_name", "") or "").strip() or "none"
        latest_tool_target = _tool_target_summary(latest_tool, (latest_tool_event.details or {}).get("tool_args", {}))

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
    latest_visible_output = _trim_preview(
        (latest_provider.details or {}).get("content_preview", "") if latest_provider else "",
        limit=280,
    ) or "none"
    metrics = trace.metrics
    summary_lines = [
        "### Live Activity",
        f"- Run ID: `{trace.run_id}`",
        f"- Run state: `{'Completed' if trace.completed else 'Cancelling' if trace.cancel_requested else 'Running'}`",
        f"- Current actor: `{current_actor}`",
        f"- Latest event: `{latest_kind}` / `{latest_status}`",
        f"- Latest tool: `{latest_tool}`",
        f"- Latest tool target: `{latest_tool_target}`",
        f"- Active model: `{latest_model}`",
        f"- Latest visible model output: `{latest_visible_output}`",
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
        target_summary = _tool_target_summary(str(details["tool_name"]), details.get("tool_args", {}))
        chips.append(f"target `{target_summary}`")
    if details.get("tool_call_names"):
        chips.append("requested " + ", ".join(f"`{name}`" for name in details["tool_call_names"]))
    if details.get("input_tokens") is not None or details.get("output_tokens") is not None:
        chips.append(f"tokens `{details.get('input_tokens', 0)}` / `{details.get('output_tokens', 0)}`")
    prefix = {"success": "Completed", "warning": "Attention", "error": "Error"}.get(event.status, "Step")
    content = f"**{prefix} | {event.actor}**\n\n{event.message}"
    if chips:
        content += "\n\n_" + " | ".join(chips) + "_"
    if event.kind == "tool_call_started" and details.get("tool_args"):
        content += f"\n\n**Tool input**\n```json\n{_json_dump(details.get('tool_args'))[:900]}\n```"
    if event.kind == "tool_call_finished" and details.get("result_preview"):
        content += f"\n\n**Tool output preview**\n```text\n{str(details['result_preview'])[:700]}\n```"
    if event.kind == "llm_response" and details.get("content_preview"):
        content += f"\n\n**Visible model output**\n```text\n{str(details['content_preview'])[:700]}\n```"
    request_lines = _tool_call_request_lines(details.get("tool_calls_payload"))
    if event.kind == "llm_response" and request_lines:
        content += "\n\n**Planned tool use**\n" + "\n".join(request_lines)
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
            handlers = {
                "agent_choice_updates": _agent_choice_updates,
                "default_pytest_targets": default_pytest_targets,
                "discover_pytest_targets": discover_pytest_targets,
                "export_dataset_ui": _export_dataset_ui,
                "load_dataset_examples": _load_dataset_examples,
                "load_observability_trace": _load_observability_trace,
                "load_tool_catalog": lambda: load_tool_catalog(settings),
                "quality_mode_updates": quality_mode_updates,
                "refresh_observability": _refresh_observability,
                "render_trace_panels": _render_trace_panels,
                "request_stop": _request_stop,
                "run_agent_test_stream": _run_agent_test_stream,
                "run_pipeline_stream": _run_pipeline_stream,
                "run_quality_task": run_quality_task,
                "sync_agent_trace_filters": _sync_agent_trace_filters,
                "sync_trace_filters": _sync_trace_filters,
                "tracing_markdown": _tracing_markdown,
            }

            build_live_pipeline_tab(demo, handlers)
            build_agent_test_lab_tab(demo, handlers)
            build_observability_tab(demo, handlers)
            build_dataset_studio_tab(demo, handlers)
            build_quality_lab_tab(demo, handlers)
    return demo


def launch(server_name: str = "0.0.0.0", server_port: int = 7860) -> None:
    setup_logging(level=settings.log_level, log_file=settings.log_file)
    setup_tracing_from_settings(settings)
    logger.info("Starting Gradio dashboard on %s:%s", server_name, server_port)
    queue_limit = max(int(os.getenv("GRADIO_QUEUE_CONCURRENCY_LIMIT", str(DEFAULT_QUEUE_CONCURRENCY_LIMIT))), 1)
    build_ui().queue(default_concurrency_limit=queue_limit).launch(
        server_name=server_name,
        server_port=server_port,
        css=APP_CSS,
        theme=gr.themes.Soft(),
    )


if __name__ == "__main__":
    launch()
