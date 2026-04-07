"""UI layout builders for the Gradio dashboard tabs."""

from __future__ import annotations

from typing import Any

import gradio as gr

from src.api.gradio.quality import (
    benchmark_tool_choices,
    default_benchmark_tools,
    default_pytest_targets,
)
from src.api.gradio.shared import (
    AGENT_OPTIONS,
    BENCHMARK_MODE_OPTIONS,
    DATASET_HEADERS,
    EVENT_HEADERS,
    PAGE_TYPE_OPTIONS,
    QUALITY_MODE_OPTIONS,
    STATUS_OPTIONS,
    compat_chatbot,
)


def build_live_pipeline_tab(demo: gr.Blocks, handlers: dict[str, Any]) -> None:
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
                pipeline_chat = compat_chatbot(label="Live Console", height=460, type="messages")
            with gr.Column(scale=5):
                pipeline_control = gr.Markdown("### Run Control\n_No active run._", elem_classes=["run-card"])
                pipeline_status = gr.Markdown("### Run Summary\n_Waiting for a run._", elem_classes=["run-card"])
                pipeline_metrics = gr.Markdown("### Metrics\n_No metrics recorded yet._", elem_classes=["run-card"])
                pipeline_tracing = gr.Markdown(handlers["tracing_markdown"](), elem_classes=["status-card"])
        with gr.Row():
            pipeline_live_summary = gr.Markdown("### Live Activity\n_No trace yet._", elem_classes=["run-card"])
            pipeline_live_inventory = gr.Markdown(
                "### Agent and Tool Inventory\n_No trace yet._",
                elem_classes=["run-card"],
            )
        pipeline_live_graph = gr.HTML(handlers["render_trace_panels"](None)[1])
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
            pipeline_filtered_graph = gr.HTML(handlers["render_trace_panels"](None)[1])
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
            handlers["run_pipeline_stream"],
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
        stop_btn.click(handlers["request_stop"], inputs=[pipeline_run_id], outputs=[pipeline_control], queue=False)
        pipeline_trace_state.change(
            handlers["sync_trace_filters"],
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
            handlers["sync_trace_filters"],
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
            handlers["render_trace_panels"],
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


def build_agent_test_lab_tab(demo: gr.Blocks, handlers: dict[str, Any]) -> None:
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
                agent_chat = compat_chatbot(label="Agent Console", height=440, type="messages")
            with gr.Column(scale=5):
                agent_control = gr.Markdown("### Run Control\n_No active run._", elem_classes=["run-card"])
                verdict_md = gr.Markdown("### Test Verdict\n_No test yet._", elem_classes=["run-card"])
                agent_metrics = gr.Markdown("### Metrics\n_No metrics recorded yet._", elem_classes=["run-card"])
                agent_tracing = gr.Markdown(handlers["tracing_markdown"](), elem_classes=["status-card"])
        with gr.Row():
            agent_live_summary = gr.Markdown("### Live Activity\n_No trace yet._", elem_classes=["run-card"])
            agent_live_inventory = gr.Markdown(
                "### Agent and Tool Inventory\n_No trace yet._",
                elem_classes=["run-card"],
            )
        agent_live_graph = gr.HTML(handlers["render_trace_panels"](None)[1])
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
            agent_filtered_graph = gr.HTML(handlers["render_trace_panels"](None)[1])
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
            handlers["agent_choice_updates"],
            inputs=[agent_choice],
            outputs=[expected_page_type, expected_status, min_streams, agent_actor_filter, agent_focus],
            queue=False,
        )
        agent_run_btn.click(
            handlers["run_agent_test_stream"],
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
        agent_stop_btn.click(handlers["request_stop"], inputs=[agent_run_id], outputs=[agent_control], queue=False)
        agent_trace_state.change(
            handlers["sync_agent_trace_filters"],
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
            handlers["sync_agent_trace_filters"],
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
            handlers["render_trace_panels"],
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


def build_observability_tab(demo: gr.Blocks, handlers: dict[str, Any]) -> None:
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
                obs_tracing = gr.Markdown(handlers["tracing_markdown"]())
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
        obs_trace_graph = gr.HTML(handlers["render_trace_panels"](None)[1])
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
            handlers["refresh_observability"],
            outputs=[obs_tracing, recent_runs, active_traces, obs_summary, obs_trace_selector],
            queue=False,
        )
        obs_trace_selector.change(
            handlers["load_observability_trace"],
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
        obs_stop_btn.click(handlers["request_stop"], inputs=[obs_trace_selector], outputs=[obs_control], queue=False)
        obs_sync_filters.click(
            handlers["sync_trace_filters"],
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
            handlers["render_trace_panels"],
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
        demo.load(
            handlers["refresh_observability"],
            outputs=[obs_tracing, recent_runs, active_traces, obs_summary, obs_trace_selector],
            queue=False,
        )


def build_dataset_studio_tab(demo: gr.Blocks, handlers: dict[str, Any]) -> None:
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
            dataset_tracing = gr.Markdown(handlers["tracing_markdown"](), elem_classes=["status-card"])
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
            handlers["load_dataset_examples"],
            inputs=[dataset_limit, dataset_name],
            outputs=[dataset_status, dataset_rows, dataset_preview],
            queue=False,
        )
        export_dataset_btn.click(
            handlers["export_dataset_ui"],
            inputs=[dataset_limit, dataset_name, dataset_path, upload_to_phoenix, dataset_description],
            outputs=[dataset_status, dataset_export_result, dataset_rows, dataset_preview],
        )
        demo.load(
            handlers["load_dataset_examples"],
            inputs=[dataset_limit, dataset_name],
            outputs=[dataset_status, dataset_rows, dataset_preview],
            queue=False,
        )
        demo.load(
            lambda: handlers["tracing_markdown"](),
            outputs=[dataset_tracing],
            queue=False,
        )


def build_quality_lab_tab(demo: gr.Blocks, handlers: dict[str, Any]) -> None:
    with gr.Tab("QA Lab"):
        gr.Markdown(
            "<div class='panel-note'>Run focused Python suites or tool benchmarks from the dashboard. Defaults stay intentionally light on RAM: selective tests, short tracebacks, mock benchmarks, and no broad coverage passes unless you ask for them.</div>"
        )
        with gr.Row():
            quality_mode = gr.Dropdown(label="Mode", choices=QUALITY_MODE_OPTIONS, value="python_tests", scale=2)
            quality_run = gr.Button("Run QA Task", variant="primary", scale=1)
            quality_refresh_tools = gr.Button("Refresh Tool Catalog", variant="secondary", scale=1)
        with gr.Row():
            with gr.Column(scale=5):
                tool_catalog_md = gr.Markdown("### Tool Catalog\n_Loading..._", elem_classes=["run-card"])
            with gr.Column(scale=7):
                tool_catalog_json = gr.Code(label="Tool Catalog (JSON)", language="json", value="{}")

        with gr.Group(visible=True) as pytest_group:
            with gr.Row():
                pytest_targets = gr.Dropdown(
                    label="Python Test Targets",
                    choices=handlers["discover_pytest_targets"](),
                    value=handlers["default_pytest_targets"](),
                    multiselect=True,
                )
                pytest_keyword = gr.Textbox(label="Keyword Filter (-k)", placeholder="optional pytest -k expression")
                pytest_fail_fast = gr.Checkbox(label="Fail Fast", value=False)

        with gr.Group(visible=False) as benchmark_group:
            with gr.Row():
                benchmark_tools = gr.Dropdown(
                    label="Benchmark Tools",
                    choices=benchmark_tool_choices(),
                    value=default_benchmark_tools(),
                    multiselect=True,
                )
                benchmark_mode = gr.Dropdown(
                    label="Benchmark Mode",
                    choices=BENCHMARK_MODE_OPTIONS,
                    value="mock",
                )
            with gr.Row():
                benchmark_repeat = gr.Slider(label="Repeat Count", minimum=1, maximum=5, step=1, value=1)
                benchmark_base_url = gr.Textbox(label="Base URL", value="https://example.com")

        with gr.Row():
            qa_status = gr.Markdown("### QA Status\n_No task run yet._", elem_classes=["run-card"])
            qa_command = gr.Textbox(label="Command Preview", lines=2, interactive=False, value="")
        qa_output = gr.Textbox(label="Task Output", lines=18, interactive=False, value="")

        quality_mode.change(
            handlers["quality_mode_updates"],
            inputs=[quality_mode],
            outputs=[pytest_group, benchmark_group],
            queue=False,
        )
        quality_refresh_tools.click(
            handlers["load_tool_catalog"],
            outputs=[tool_catalog_md, tool_catalog_json],
            queue=False,
        )
        quality_run.click(
            handlers["run_quality_task"],
            inputs=[
                quality_mode,
                pytest_targets,
                pytest_keyword,
                pytest_fail_fast,
                benchmark_tools,
                benchmark_mode,
                benchmark_repeat,
                benchmark_base_url,
            ],
            outputs=[qa_status, qa_command, qa_output],
        )
        demo.load(handlers["load_tool_catalog"], outputs=[tool_catalog_md, tool_catalog_json], queue=False)
