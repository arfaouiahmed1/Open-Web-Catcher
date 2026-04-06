"""Interactive Gradio dashboard for live runs, agent tests, and observability."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from typing import Any

import gradio as gr

from src.evaluation.tracing import setup_tracing_from_settings
from src.agents.classification import ClassificationAgent
from src.agents.embedded_page import EmbeddedPageAgent
from src.agents.hosting_page import HostingPageAgent
from src.agents.landing_page import LandingPageAgent
from src.agents.orchestrator import run_pipeline
from src.models.enums import ExtractionStatus
from src.models.schemas import ClassificationResult, ExtractionResult, PipelineResult, RunMetrics
from src.storage.database import get_session
from src.storage.repositories import RunRepository
from src.utils.config import Settings
from src.utils.logging import get_logger, setup_logging
from src.utils.observability import RunObserver, RuntimeEvent, get_tracing_status, run_registry

settings = Settings.from_yaml()
logger = get_logger(__name__)

APP_CSS = """
.app-shell {max-width: 1320px; margin: 0 auto; padding-bottom: 2rem;}
.hero {padding: 1.25rem 1.5rem; border-radius: 22px; background:
linear-gradient(135deg, #13293d 0%, #1b4965 45%, #5fa8d3 100%);
color: #f6fbff; box-shadow: 0 16px 40px rgba(19, 41, 61, 0.22);}
.hero h1 {margin: 0; font-size: 2rem;}
.hero p {margin: 0.5rem 0 0 0; max-width: 840px;}
.panel-note {padding: 0.9rem 1rem; border-radius: 16px; background: #f4efe6; border: 1px solid #e3d4bc;}
.status-card {padding: 1rem 1.1rem; border-radius: 18px; background: #fffaf3; border: 1px solid #eadbc8;}
"""


def _json_dump(value: Any) -> str:
    if value is None:
        return "{}"
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.dumps(value, indent=2, ensure_ascii=False)


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
    model_lines = "\n".join(
        f"- `{entry.model_name}` ({entry.provider or 'unknown'}): calls `{entry.llm_calls}`, tokens `{entry.input_tokens}` / `{entry.output_tokens}`, cost `${entry.estimated_total_cost_usd:.6f}`"
        for entry in metrics.model_usage
    ) or "- None"
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


def _chat_message(role: str, content: str) -> dict[str, str]:
    return {"role": role, "content": content}


def _event_to_chat_message(event: RuntimeEvent) -> dict[str, str]:
    details = []
    if "tool_name" in event.details:
        details.append(f"tool `{event.details['tool_name']}`")
    if "page_type" in event.details:
        details.append(f"page type `{event.details['page_type']}`")
    if "streams_found" in event.details:
        details.append(f"streams `{event.details['streams_found']}`")
    if "hosting_pages_found" in event.details:
        details.append(f"hosting pages `{event.details['hosting_pages_found']}`")
    if "duration_seconds" in event.details:
        details.append(f"{event.details['duration_seconds']}s")
    suffix = f"\n\n_{' | '.join(details)}_" if details else ""
    prefix = {
        "success": "Completed",
        "warning": "Attention",
        "error": "Error",
    }.get(event.status, "Step")
    content = f"**{prefix} | {event.actor}**\n\n{event.message}{suffix}"
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
        new_events = observer.events_since(last_seq)
        for event in new_events:
            chat_history.append(_event_to_chat_message(event))
            last_seq = event.seq
        yield chat_history, observer.trace()
        time.sleep(0.25)

    worker.join()
    if "error" in error_holder:
        error = error_holder["error"]
        observer.emit("run_failed", str(error), status="error")
        observer.finish(success=False, failure_mode=type(error).__name__)
        chat_history.append(_chat_message("assistant", f"**Error | {observer.actor}**\n\n{error}"))
    yield chat_history, observer.trace()


def _run_pipeline_stream(url: str):
    if not url.strip():
        yield [], "### Run Summary\nPlease provide a URL.", "{}", [], "### Takedown Emails\n_No run yet._", "### Metrics\n_No metrics recorded yet._", _tracing_markdown(), ""
        return

    normalized_url = url.strip()
    observer = _new_observer("orchestrator", normalized_url)
    chat_history: list[dict[str, str]] = [
        _chat_message("user", f"Run the orchestrator for `{normalized_url}`."),
        _chat_message("assistant", "Preparing pipeline, sub-agents, and observability."),
    ]
    result_holder: dict[str, Any] = {}
    error_holder: dict[str, Any] = {}
    worker = threading.Thread(
        target=_run_async,
        args=(run_pipeline(url=normalized_url, settings=settings, observer=observer), result_holder, error_holder),
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
        )


async def _run_selected_agent(agent_key: str, url: str, observer: RunObserver):
    if agent_key == "classification":
        return await ClassificationAgent(settings).run(url=url, observer=observer)
    if agent_key == "landing":
        return await LandingPageAgent(settings).run(url=url, observer=observer)
    if agent_key == "hosting":
        return await HostingPageAgent(settings).run(url=url, observer=observer)
    if agent_key == "embedded":
        return await EmbeddedPageAgent(settings).run(url=url, observer=observer)
    raise ValueError(f"Unknown agent '{agent_key}'")


def _run_agent_test_stream(
    agent_key: str,
    url: str,
    expected_page_type: str,
    expected_status: str,
    min_streams: int,
):
    if not url.strip():
        yield [], "### Test Verdict\nPlease provide a URL.", "{}", "### Metrics\n_No metrics recorded yet._", _tracing_markdown(), ""
        return

    normalized_url = url.strip()
    observer = _new_observer(agent_key, normalized_url)
    chat_history: list[dict[str, str]] = [
        _chat_message("user", f"Run the `{agent_key}` agent as a test for `{normalized_url}`."),
        _chat_message("assistant", "Launching the selected agent and collecting step-by-step trace data."),
    ]
    result_holder: dict[str, Any] = {}
    error_holder: dict[str, Any] = {}
    worker = threading.Thread(
        target=_run_async,
        args=(_run_selected_agent(agent_key, normalized_url, observer), result_holder, error_holder),
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
        )


def _refresh_observability():
    session = get_session()
    try:
        repo = RunRepository(session)
        recent_runs = repo.list_recent(limit=15)
        run_rows = [
            [
                record.run_id,
                record.status,
                record.streams_found,
                record.tool_calls,
                record.tokens_in,
                record.tokens_out,
                round(record.duration_seconds or 0.0, 2),
                record.created_at.isoformat(),
            ]
            for record in recent_runs
        ]
        active_trace_rows = [
            [
                trace.run_id,
                trace.root_actor,
                len(trace.events),
                trace.metrics.total_tool_calls if trace.metrics else 0,
                trace.completed,
                trace.started_at.isoformat(),
            ]
            for trace in run_registry.list_recent(limit=15)
        ]
        summary = {
            "tracing": get_tracing_status(settings).model_dump(mode="json"),
            "database_success_rate": repo.success_rate(),
            "recent_run_count": len(run_rows),
            "active_trace_count": len(active_trace_rows),
        }
        return _tracing_markdown(), run_rows, active_trace_rows, _json_dump(summary)
    finally:
        session.close()


def build_ui() -> gr.Blocks:
    with gr.Blocks(title="Open Web Catcher Control Room") as demo:
        with gr.Column(elem_classes=["app-shell"]):
            gr.Markdown(
                """
                <div class="hero">
                  <h1>Open Web Catcher Control Room</h1>
                  <p>
                    Run the orchestrator or any specialist agent, watch the pipeline unfold step by step,
                    and verify Phoenix traces plus local metrics without leaving the dashboard.
                  </p>
                </div>
                """
            )

            with gr.Tab("Live Pipeline"):
                with gr.Row():
                    with gr.Column(scale=2):
                        url_in = gr.Textbox(
                            label="Target URL",
                            placeholder="https://example-streaming-site.com/watch/123",
                        )
                    with gr.Column(scale=1):
                        pipeline_run_id = gr.Textbox(label="Run ID", interactive=False)
                        run_btn = gr.Button("Run Orchestrator", variant="primary")

                with gr.Row():
                    with gr.Column(scale=7):
                        pipeline_chat = gr.Chatbot(label="Step-by-Step Console", height=520)
                    with gr.Column(scale=5):
                        pipeline_status = gr.Markdown("### Run Summary\n_Waiting for a run._")
                        pipeline_metrics = gr.Markdown("### Metrics\n_No metrics recorded yet._")
                        pipeline_tracing = gr.Markdown(_tracing_markdown())

                pipeline_streams = gr.Dataframe(
                    headers=["URL", "Protocol", "Quality", "Source"],
                    label="Streams",
                    row_count=6,
                    col_count=(4, "fixed"),
                )
                pipeline_result = gr.Code(label="Pipeline Result (JSON)", language="json")
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
                    ],
                )

            with gr.Tab("Agent Test Lab"):
                gr.Markdown(
                    """
                    <div class="panel-note">
                      Run a single agent with lightweight assertions. This is useful for focused prompt checks,
                      browser tool debugging, and quick eval-style smoke tests.
                    </div>
                    """
                )
                with gr.Row():
                    agent_choice = gr.Dropdown(
                        label="Agent",
                        choices=[
                            ("Classification", "classification"),
                            ("Landing Page", "landing"),
                            ("Hosting Page", "hosting"),
                            ("Embedded Page", "embedded"),
                        ],
                        value="classification",
                    )
                    agent_url = gr.Textbox(label="URL Under Test", placeholder="https://example.com")
                    agent_run_id = gr.Textbox(label="Run ID", interactive=False)

                with gr.Row():
                    expected_page_type = gr.Dropdown(
                        label="Expected Page Type",
                        choices=["any", "landing_page", "hosting_page", "embedded_page", "unknown"],
                        value="any",
                    )
                    expected_status = gr.Dropdown(
                        label="Expected Extraction Status",
                        choices=["any", "success", "partial", "failed"],
                        value="any",
                    )
                    min_streams = gr.Slider(label="Minimum Streams", minimum=0, maximum=10, value=0, step=1)
                    agent_run_btn = gr.Button("Run Agent Test", variant="primary")

                with gr.Row():
                    with gr.Column(scale=7):
                        agent_chat = gr.Chatbot(label="Agent Trace", height=480)
                    with gr.Column(scale=5):
                        verdict_md = gr.Markdown("### Test Verdict\n_No test yet._")
                        agent_metrics = gr.Markdown("### Metrics\n_No metrics recorded yet._")
                        agent_tracing = gr.Markdown(_tracing_markdown())

                agent_result = gr.Code(label="Agent Result (JSON)", language="json")

                agent_run_btn.click(
                    _run_agent_test_stream,
                    inputs=[agent_choice, agent_url, expected_page_type, expected_status, min_streams],
                    outputs=[agent_chat, verdict_md, agent_result, agent_metrics, agent_tracing, agent_run_id],
                )

            with gr.Tab("Observability"):
                gr.Markdown(
                    """
                    <div class="status-card">
                      This panel combines live in-memory traces with database-backed run history so you can see
                      whether the system is merely configured, actually tracing, and accumulating useful metrics.
                    </div>
                    """
                )
                refresh_btn = gr.Button("Refresh Observability", variant="secondary")
                obs_tracing = gr.Markdown(_tracing_markdown())
                recent_runs = gr.Dataframe(
                    headers=["Run ID", "Status", "Streams", "Tool Calls", "Tokens In", "Tokens Out", "Seconds", "Created At"],
                    label="Recent Persisted Runs",
                    row_count=12,
                    col_count=(8, "fixed"),
                )
                active_traces = gr.Dataframe(
                    headers=["Run ID", "Actor", "Events", "Tool Calls", "Completed", "Started At"],
                    label="Recent In-Memory Traces",
                    row_count=12,
                    col_count=(6, "fixed"),
                )
                obs_summary = gr.Code(label="Observability Snapshot", language="json")
                refresh_btn.click(
                    _refresh_observability,
                    outputs=[obs_tracing, recent_runs, active_traces, obs_summary],
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
