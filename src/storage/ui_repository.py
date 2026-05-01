"""Repository helpers for the Next.js operator console."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from src.models.schemas import (
    EvaluationCase,
    EvaluationCaseResult,
    EvaluationRun,
    EvaluationSuite,
    PricingConfig,
    ProviderInfo,
)
from src.storage.models import (
    AgentOutputRecord,
    AgentRunRecord,
    BackgroundJobRecord,
    DatasetBatchRecord,
    DatasetSiteRecord,
    DatasetSiteRunRecord,
    EvaluationCaseRecord,
    EvaluationCaseResultRecord,
    EvaluationRunRecord,
    EvaluationSuiteRecord,
    LLMCallRecord,
    MemoryEntryRecord,
    MemoryHintUsedRecord,
    PipelineRunRecord,
    PricingConfigRecord,
    PromptCompilationRecord,
    PromptVersionRecord,
    ProviderAnalysisRecord,
    ProviderLookupCheckRecord,
    RunModelUsageRecord,
    RunRecord,
    RunScreenshotRecord,
    RunSnapshotRecord,
    RunStreamRecord,
    RuntimeEventRecord,
    TakedownEmailRecord,
    ToolCallRecord,
    ToolPlaygroundCallRecord,
)
from src.utils.console_state import (
    country_code_from_value,
    flag_emoji_from_country_code,
    normalize_job_display_status,
    normalize_run_display_status,
)


def _json_ready(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_ready(item) for key, item in value.items()}
    return value


def _max_concurrency(items: list[dict[str, Any]]) -> int:
    timeline: list[tuple[datetime, int]] = []
    for item in items:
        started_at = item.get("started_at")
        finished_at = item.get("finished_at")
        status = str(item.get("status", "") or "").strip().lower()
        if not isinstance(started_at, datetime):
            continue
        timeline.append((started_at, 1))
        if isinstance(finished_at, datetime):
            timeline.append((finished_at, -1))
        elif status in {"running", "queued"}:
            timeline.append((datetime.utcnow(), -1))
    active = 0
    peak = 0
    for _, delta in sorted(timeline, key=lambda entry: (entry[0], -entry[1])):
        active += delta
        peak = max(peak, active)
    return peak


def _aggregate_agent_status(statuses: list[str]) -> str:
    normalized = [
        str(value or "").strip().lower() for value in statuses if str(value or "").strip()
    ]
    if not normalized:
        return "unknown"
    if any(value == "running" for value in normalized):
        return "running"
    if any(value == "queued" for value in normalized):
        return "queued"
    if any(value == "failed" for value in normalized):
        return "failed"
    if any(value == "cancelled" for value in normalized):
        return "cancelled"
    if any(value == "partial" for value in normalized):
        return "partial"
    if all(value == "success" for value in normalized):
        return "success"
    return normalized[-1]


class OperatorConsoleRepository:
    TABLE_MAP = {
        "pipeline_runs": PipelineRunRecord,
        "run_snapshots": RunSnapshotRecord,
        "agent_runs": AgentRunRecord,
        "agent_outputs": AgentOutputRecord,
        "llm_calls": LLMCallRecord,
        "tool_calls": ToolCallRecord,
        "tool_playground_calls": ToolPlaygroundCallRecord,
        "background_jobs": BackgroundJobRecord,
        "provider_lookup_checks": ProviderLookupCheckRecord,
        "runtime_events": RuntimeEventRecord,
        "prompt_versions": PromptVersionRecord,
        "prompt_compilations": PromptCompilationRecord,
        "run_model_usage": RunModelUsageRecord,
        "memory_entries": MemoryEntryRecord,
        "run_streams": RunStreamRecord,
        "run_screenshots": RunScreenshotRecord,
        "provider_analyses": ProviderAnalysisRecord,
        "takedown_emails": TakedownEmailRecord,
        "pricing_configs": PricingConfigRecord,
        "evaluation_suites": EvaluationSuiteRecord,
        "evaluation_cases": EvaluationCaseRecord,
        "evaluation_runs": EvaluationRunRecord,
        "evaluation_case_results": EvaluationCaseResultRecord,
        "dataset_sites": DatasetSiteRecord,
        "dataset_batches": DatasetBatchRecord,
        "dataset_site_runs": DatasetSiteRunRecord,
        "runs": RunRecord,
        "memory_hints_used": MemoryHintUsedRecord,
    }

    def __init__(self, session: Session) -> None:
        self._session = session

    def list_pricing_configs(self) -> list[PricingConfig]:
        rows = (
            self._session.query(PricingConfigRecord)
            .order_by(
                PricingConfigRecord.active.desc(),
                PricingConfigRecord.provider.asc(),
                PricingConfigRecord.model_name.asc(),
            )
            .all()
        )
        return [
            PricingConfig(
                provider=row.provider,
                model_name=row.model_name,
                input_per_million=row.input_per_million,
                output_per_million=row.output_per_million,
                active=row.active,
                notes=row.notes,
            )
            for row in rows
        ]

    def upsert_pricing_config(self, config: PricingConfig) -> PricingConfig:
        row = (
            self._session.query(PricingConfigRecord)
            .filter_by(provider=config.provider, model_name=config.model_name)
            .first()
        )
        if row is None:
            row = PricingConfigRecord(provider=config.provider, model_name=config.model_name)
            self._session.add(row)
        row.input_per_million = config.input_per_million
        row.output_per_million = config.output_per_million
        row.active = config.active
        row.notes = config.notes
        self._session.commit()
        return config

    def upsert_pricing_configs(self, configs: list[PricingConfig]) -> int:
        if not configs:
            return 0

        # Batch-fetch all existing records in one query
        keys = [(c.provider, c.model_name) for c in configs]
        existing_rows = (
            self._session.query(PricingConfigRecord)
            .filter(
                func.concat(PricingConfigRecord.provider, "||", PricingConfigRecord.model_name).in_(
                    [f"{p}||{m}" for p, m in keys]
                )
            )
            .all()
        )
        row_map = {(r.provider, r.model_name): r for r in existing_rows}

        for config in configs:
            key = (config.provider, config.model_name)
            row = row_map.get(key)
            if row is None:
                row = PricingConfigRecord(provider=config.provider, model_name=config.model_name)
                self._session.add(row)
                row_map[key] = row
            row.input_per_million = config.input_per_million
            row.output_per_million = config.output_per_million
            row.active = config.active
            row.notes = config.notes

        self._session.commit()
        return len(configs)

    def get_overview(
        self, active_traces: list[dict[str, Any]] | None = None, limit: int = 8
    ) -> dict[str, Any]:
        recent_runs = (
            self._session.query(PipelineRunRecord)
            .order_by(PipelineRunRecord.created_at.desc())
            .limit(max(limit, 1))
            .all()
        )
        eval_runs = (
            self._session.query(EvaluationRunRecord)
            .order_by(EvaluationRunRecord.started_at.desc())
            .limit(50)
            .all()
        )

        pipeline_totals = self._session.query(
            func.count(PipelineRunRecord.id),
            func.coalesce(
                func.sum(case((PipelineRunRecord.final_status == "success", 1), else_=0)), 0
            ),
            func.coalesce(
                func.sum(case((PipelineRunRecord.final_status == "partial", 1), else_=0)), 0
            ),
            func.coalesce(
                func.sum(case((PipelineRunRecord.final_status == "failed", 1), else_=0)), 0
            ),
            func.coalesce(
                func.sum(case((PipelineRunRecord.final_status == "running", 1), else_=0)), 0
            ),
            func.coalesce(func.sum(PipelineRunRecord.total_tokens_in), 0),
            func.coalesce(func.sum(PipelineRunRecord.total_tokens_out), 0),
            func.coalesce(func.sum(PipelineRunRecord.total_llm_calls), 0),
            func.coalesce(func.sum(PipelineRunRecord.total_tool_calls), 0),
            func.coalesce(func.sum(PipelineRunRecord.estimated_total_cost_usd), 0.0),
            func.coalesce(func.avg(PipelineRunRecord.duration_seconds), 0.0),
            func.coalesce(func.sum(case((PipelineRunRecord.stream_count > 0, 1), else_=0)), 0),
            func.coalesce(func.sum(case((PipelineRunRecord.email_count > 0, 1), else_=0)), 0),
            func.coalesce(func.sum(PipelineRunRecord.stream_count), 0),
            func.coalesce(func.sum(PipelineRunRecord.email_count), 0),
            func.coalesce(func.sum(PipelineRunRecord.provider_analysis_count), 0),
        ).one()
        total_runs = int(pipeline_totals[0] or 0)
        success_count = int(pipeline_totals[1] or 0)
        partial_count = int(pipeline_totals[2] or 0)
        failure_count = int(pipeline_totals[3] or 0)
        running_count = int(pipeline_totals[4] or 0)
        total_tokens_in = int(pipeline_totals[5] or 0)
        total_tokens_out = int(pipeline_totals[6] or 0)
        total_llm_calls = int(pipeline_totals[7] or 0)
        total_tool_calls = int(pipeline_totals[8] or 0)
        total_cost = float(pipeline_totals[9] or 0.0)
        avg_latency = float(pipeline_totals[10] or 0.0)
        runs_with_streams = int(pipeline_totals[11] or 0)
        runs_with_emails = int(pipeline_totals[12] or 0)
        total_streams = int(pipeline_totals[13] or 0)
        total_emails = int(pipeline_totals[14] or 0)
        total_provider_analyses = int(pipeline_totals[15] or 0)
        terminal_runs = success_count + partial_count + failure_count
        rate_denominator = terminal_runs if terminal_runs > 0 else total_runs
        total_tokens = total_tokens_in + total_tokens_out

        pipeline_ids_with_tool_rows = {
            int(pipeline_id)
            for (pipeline_id,) in (
                self._session.query(AgentRunRecord.pipeline_run_id)
                .join(ToolCallRecord, ToolCallRecord.agent_run_id == AgentRunRecord.id)
                .distinct()
                .all()
            )
        }
        tool_totals = self._session.query(
            func.count(ToolCallRecord.id),
            func.coalesce(func.sum(case((ToolCallRecord.status == "success", 1), else_=0)), 0),
            func.coalesce(func.sum(case((ToolCallRecord.status == "error", 1), else_=0)), 0),
            func.coalesce(func.avg(ToolCallRecord.duration_seconds), 0.0),
        ).one()
        observed_tool_calls = int(tool_totals[0] or 0)
        successful_tool_calls = int(tool_totals[1] or 0)
        failed_tool_calls = int(tool_totals[2] or 0)
        avg_tool_duration = float(tool_totals[3] or 0.0)

        tool_event_fallback = self._runtime_tool_rollup(
            excluded_pipeline_ids=pipeline_ids_with_tool_rows
        )
        fallback_tool_duration_count = int(tool_event_fallback.get("duration_count", 0) or 0)
        fallback_tool_duration_sum = float(tool_event_fallback.get("duration_sum", 0.0) or 0.0)

        observed_tool_calls += int(tool_event_fallback.get("calls", 0) or 0)
        successful_tool_calls += int(tool_event_fallback.get("successes", 0) or 0)
        failed_tool_calls += int(tool_event_fallback.get("errors", 0) or 0)

        db_duration_count = int(tool_totals[0] or 0)
        db_duration_sum = float(avg_tool_duration or 0.0) * db_duration_count
        total_duration_count = db_duration_count + fallback_tool_duration_count
        total_duration_sum = db_duration_sum + fallback_tool_duration_sum
        avg_tool_duration = (
            (total_duration_sum / total_duration_count) if total_duration_count else 0.0
        )

        model_breakdown_rows, llm_usage_totals = self._merged_model_usage_rows(limit=12)

        provider_rows = (
            self._session.query(
                ProviderAnalysisRecord.provider,
                func.count(ProviderAnalysisRecord.id),
                func.count(func.distinct(ProviderAnalysisRecord.pipeline_run_id)),
            )
            .filter(ProviderAnalysisRecord.provider != "")
            .group_by(ProviderAnalysisRecord.provider)
            .order_by(
                func.count(ProviderAnalysisRecord.id).desc(), ProviderAnalysisRecord.provider.asc()
            )
            .limit(10)
            .all()
        )
        unique_provider_count = int(
            self._session.query(func.count(func.distinct(ProviderAnalysisRecord.provider)))
            .filter(ProviderAnalysisRecord.provider != "")
            .scalar()
            or 0
        )

        top_tool_rows = self._merged_top_tool_rows(limit=10)

        trend_buckets = self._daily_trend(window_days=7)

        eval_summary = {
            "total_runs": len(eval_runs),
            "latest_success_rate": float(eval_runs[0].success_rate or 0.0) if eval_runs else 0.0,
            "latest_hallucination_rate": float(eval_runs[0].hallucination_rate or 0.0)
            if eval_runs
            else 0.0,
            "latest_tool_accuracy_rate": float(eval_runs[0].tool_accuracy_rate or 0.0)
            if eval_runs
            else 0.0,
            "latest_reliability_rate": float(eval_runs[0].reliability_rate or 0.0)
            if eval_runs
            else 0.0,
            "avg_success_rate": round(
                sum(float(row.success_rate or 0.0) for row in eval_runs) / len(eval_runs),
                4,
            )
            if eval_runs
            else 0.0,
        }

        background_totals = self._session.query(
            func.coalesce(func.sum(case((BackgroundJobRecord.status == "queued", 1), else_=0)), 0),
            func.coalesce(
                func.sum(
                    case((BackgroundJobRecord.status.in_(["running", "retrying"]), 1), else_=0)
                ),
                0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        (
                            (BackgroundJobRecord.job_type == "workflow")
                            & (BackgroundJobRecord.status.in_(["queued", "running", "retrying"])),
                            1,
                        ),
                        else_=0,
                    )
                ),
                0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        (
                            (BackgroundJobRecord.job_type == "agent")
                            & (BackgroundJobRecord.status.in_(["queued", "running", "retrying"])),
                            1,
                        ),
                        else_=0,
                    )
                ),
                0,
            ),
        ).one()
        failed_window_count = int(
            self._session.query(func.count(PipelineRunRecord.id))
            .filter(PipelineRunRecord.final_status == "failed")
            .filter(PipelineRunRecord.created_at >= datetime.utcnow() - timedelta(hours=24))
            .scalar()
            or 0
        )

        recent_parallelism = 0
        recent_run_ids = [row.id for row in recent_runs]
        if recent_run_ids:
            recent_agent_rows = (
                self._session.query(
                    AgentRunRecord.pipeline_run_id,
                    AgentRunRecord.status,
                    AgentRunRecord.started_at,
                    AgentRunRecord.finished_at,
                )
                .filter(AgentRunRecord.pipeline_run_id.in_(recent_run_ids))
                .all()
            )
            grouped_parallelism: dict[int, list[dict[str, Any]]] = defaultdict(list)
            for pipeline_run_id, agent_status, started_at, finished_at in recent_agent_rows:
                grouped_parallelism[int(pipeline_run_id)].append(
                    {
                        "status": agent_status,
                        "started_at": started_at,
                        "finished_at": finished_at,
                    }
                )
            recent_parallelism = max(
                (_max_concurrency(items) for items in grouped_parallelism.values()), default=0
            )

        active_traces = active_traces or []
        active_workflows = len(
            [
                trace
                for trace in active_traces
                if not bool(trace.get("completed"))
                and str(trace.get("root_actor", "") or "") == "orchestrator"
            ]
        )
        active_agents = len(
            [
                trace
                for trace in active_traces
                if not bool(trace.get("completed"))
                and str(trace.get("root_actor", "") or "") != "orchestrator"
            ]
        )
        provider_coverage = (
            round(unique_provider_count / total_provider_analyses, 4)
            if total_provider_analyses
            else 0.0
        )

        return {
            "summary": {
                "total_runs": total_runs,
                "terminal_runs": terminal_runs,
                "running_runs": running_count,
                "success_rate": round(success_count / rate_denominator, 4)
                if rate_denominator
                else 0.0,
                "partial_rate": round(partial_count / rate_denominator, 4)
                if rate_denominator
                else 0.0,
                "failure_rate": round(failure_count / rate_denominator, 4)
                if rate_denominator
                else 0.0,
                "total_tokens_in": total_tokens_in,
                "total_cached_input_tokens": int(
                    llm_usage_totals.get("cached_input_tokens", 0) or 0
                ),
                "total_new_input_tokens": int(llm_usage_totals.get("new_input_tokens", 0) or 0),
                "total_tokens_out": total_tokens_out,
                "total_tokens": total_tokens,
                "total_llm_calls": total_llm_calls,
                "total_tool_calls": total_tool_calls,
                "observed_tool_calls": observed_tool_calls,
                "successful_tool_calls": successful_tool_calls,
                "failed_tool_calls": failed_tool_calls,
                "tool_success_rate": round(successful_tool_calls / observed_tool_calls, 4)
                if observed_tool_calls
                else 0.0,
                "tool_failure_rate": round(failed_tool_calls / observed_tool_calls, 4)
                if observed_tool_calls
                else 0.0,
                "avg_tool_duration_seconds": round(avg_tool_duration, 3),
                "total_cost_usd": round(total_cost, 6),
                "avg_cost_usd": round(total_cost / rate_denominator, 6)
                if rate_denominator
                else 0.0,
                "avg_latency_seconds": round(avg_latency, 3),
                "runs_with_streams": runs_with_streams,
                "runs_with_emails": runs_with_emails,
                "stream_yield_rate": round(runs_with_streams / rate_denominator, 4)
                if rate_denominator
                else 0.0,
                "email_yield_rate": round(runs_with_emails / rate_denominator, 4)
                if rate_denominator
                else 0.0,
                "total_streams": total_streams,
                "total_emails": total_emails,
                "avg_streams_per_run": round(total_streams / rate_denominator, 3)
                if rate_denominator
                else 0.0,
                "avg_emails_per_run": round(total_emails / rate_denominator, 3)
                if rate_denominator
                else 0.0,
                "total_provider_analyses": total_provider_analyses,
                "active_runs": len(
                    [trace for trace in active_traces if not bool(trace.get("completed"))]
                ),
                "queued_jobs": int(background_totals[0] or 0),
                "running_jobs": int(background_totals[1] or 0),
                "running_workflows": active_workflows + int(background_totals[2] or 0),
                "running_agent_invocations": active_agents + int(background_totals[3] or 0),
                "recent_max_parallelism": recent_parallelism,
                "failed_run_window_24h": failed_window_count,
                "provider_coverage": provider_coverage,
                "unique_providers": unique_provider_count,
            },
            "trend": trend_buckets,
            "model_breakdown": model_breakdown_rows,
            "provider_breakdown": [
                {
                    "provider": provider,
                    "analysis_count": int(count or 0),
                    "affected_runs": int(run_count or 0),
                }
                for provider, count, run_count in provider_rows
            ],
            "top_tools": [
                {
                    "tool_name": tool_name,
                    "calls": int(count or 0),
                    "successes": int(successes or 0),
                    "errors": int(errors or 0),
                    "success_rate": round((int(successes or 0) / int(count or 1)), 4)
                    if count
                    else 0.0,
                    "avg_duration_seconds": round(float(avg_duration or 0.0), 3),
                }
                for tool_name, count, successes, errors, avg_duration in top_tool_rows
            ],
            "recent_runs": [self._run_row(row) for row in recent_runs],
            "evaluation_summary": eval_summary,
            "active_runs": active_traces,
        }

    def list_runs(
        self,
        *,
        limit: int = 25,
        offset: int = 0,
        status: str = "",
        page_type: str = "",
        query: str = "",
        actor: str = "",
    ) -> dict[str, Any]:
        query_obj = self._session.query(PipelineRunRecord)
        if status:
            query_obj = query_obj.filter(PipelineRunRecord.final_status == status)
        if page_type:
            query_obj = query_obj.filter(PipelineRunRecord.page_type == page_type)
        # DB-level text search across url + run_id + page_type (avoids loading all rows)
        if query:
            q = f"%{query.strip().lower()}%"
            query_obj = query_obj.filter(
                func.lower(PipelineRunRecord.root_url).like(q)
                | func.lower(PipelineRunRecord.run_id).like(q)
                | func.lower(PipelineRunRecord.final_status).like(q)
                | func.lower(PipelineRunRecord.page_type).like(q)
            )
        # DB-level actor filter via AgentRunRecord join (avoids loading all rows)
        if actor:
            actor_lower = actor.strip().lower()
            actor_subq = (
                self._session.query(AgentRunRecord.pipeline_run_id)
                .filter(func.lower(AgentRunRecord.actor) == actor_lower)
                .distinct()
            )
            query_obj = query_obj.filter(PipelineRunRecord.id.in_(actor_subq))
        # DB-level count (cheap — no row hydration) then paginated fetch
        total = query_obj.count()
        rows = (
            query_obj.order_by(PipelineRunRecord.created_at.desc())
            .offset(max(offset, 0))
            .limit(max(limit, 1))
            .all()
        )
        run_ids = [row.id for row in rows]
        model_map: dict[int, tuple[str, str]] = {}
        root_actor_map: dict[int, str] = {}
        max_parallelism_map: dict[int, int] = {}
        if run_ids:
            max_calls_sq = (
                self._session.query(
                    RunModelUsageRecord.pipeline_run_id,
                    func.max(RunModelUsageRecord.llm_calls).label("max_calls"),
                )
                .filter(RunModelUsageRecord.pipeline_run_id.in_(run_ids))
                .group_by(RunModelUsageRecord.pipeline_run_id)
                .subquery()
            )
            dominant = (
                self._session.query(
                    RunModelUsageRecord.pipeline_run_id,
                    RunModelUsageRecord.provider,
                    RunModelUsageRecord.model_name,
                )
                .join(
                    max_calls_sq,
                    (RunModelUsageRecord.pipeline_run_id == max_calls_sq.c.pipeline_run_id)
                    & (RunModelUsageRecord.llm_calls == max_calls_sq.c.max_calls),
                )
                .all()
            )
            for d in dominant:
                if d.pipeline_run_id not in model_map:
                    model_map[d.pipeline_run_id] = (d.provider, d.model_name)

            agent_rows = (
                self._session.query(
                    AgentRunRecord.pipeline_run_id,
                    AgentRunRecord.actor,
                    AgentRunRecord.status,
                    AgentRunRecord.started_at,
                    AgentRunRecord.finished_at,
                    AgentRunRecord.id,
                )
                .filter(AgentRunRecord.pipeline_run_id.in_(run_ids))
                .order_by(
                    AgentRunRecord.pipeline_run_id.asc(),
                    AgentRunRecord.started_at.asc(),
                    AgentRunRecord.id.asc(),
                )
                .all()
            )
            agent_groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
            for pipeline_run_id, root_actor, agent_status, started_at, finished_at, _ in agent_rows:
                pipeline_key = int(pipeline_run_id)
                if pipeline_key not in root_actor_map:
                    root_actor_map[pipeline_key] = str(root_actor or "")
                agent_groups[pipeline_key].append(
                    {
                        "status": agent_status,
                        "started_at": started_at,
                        "finished_at": finished_at,
                    }
                )
            max_parallelism_map = {
                pipeline_run_id: _max_concurrency(items)
                for pipeline_run_id, items in agent_groups.items()
            }

        result_rows = []
        for row in rows:
            r = self._run_row(
                row,
                root_actor=root_actor_map.get(row.id, ""),
                job_status="",
                max_parallel_agents=max_parallelism_map.get(row.id, 0),
            )
            provider, model_name = model_map.get(row.id, ("", ""))
            r["primary_provider"] = provider
            r["primary_model"] = model_name
            result_rows.append(r)
        return {"total": total, "rows": result_rows}

    def get_run_detail(self, run_id: str) -> dict[str, Any] | None:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return None
        snapshot = self._session.query(RunSnapshotRecord).filter_by(run_id=run_id).first()
        job = self._session.query(BackgroundJobRecord).filter_by(run_id=run_id).first()
        agent_runs = (
            self._session.query(AgentRunRecord)
            .filter_by(pipeline_run_id=pipeline.id)
            .order_by(AgentRunRecord.started_at.asc())
            .all()
        )
        tool_calls = (
            self._session.query(ToolCallRecord)
            .join(AgentRunRecord, AgentRunRecord.id == ToolCallRecord.agent_run_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(ToolCallRecord.started_at.asc())
            .all()
        )
        llm_calls = (
            self._session.query(LLMCallRecord)
            .join(AgentRunRecord, AgentRunRecord.id == LLMCallRecord.agent_run_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(LLMCallRecord.created_at.asc())
            .all()
        )
        events = (
            self._session.query(RuntimeEventRecord)
            .filter_by(pipeline_run_id=pipeline.id)
            .order_by(RuntimeEventRecord.seq.asc())
            .all()
        )
        outputs = (
            self._session.query(AgentOutputRecord, AgentRunRecord)
            .join(AgentRunRecord, AgentRunRecord.id == AgentOutputRecord.agent_run_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(AgentRunRecord.started_at.asc(), AgentRunRecord.id.asc())
            .all()
        )

        output_map: dict[int, dict[str, Any]] = {}
        agent_output_rows: list[dict[str, Any]] = []
        for output_row, agent_row in outputs:
            payload = self._serialize_model(output_row)
            payload["agent_run_id"] = int(agent_row.id)
            payload["actor"] = str(agent_row.actor or "")
            payload["agent_type"] = str(agent_row.agent_type or "")
            payload["invocation_index"] = int(agent_row.invocation_index or 0)
            output_map[int(agent_row.id)] = payload
            agent_output_rows.append(payload)

        llm_by_agent: dict[int, list[LLMCallRecord]] = defaultdict(list)
        for llm_call in llm_calls:
            llm_by_agent[int(llm_call.agent_run_id)].append(llm_call)

        tool_by_agent: dict[int, list[ToolCallRecord]] = defaultdict(list)
        for tool_call in tool_calls:
            tool_by_agent[int(tool_call.agent_run_id)].append(tool_call)

        agent_rollups: list[dict[str, Any]] = []
        stage_rollups: dict[str, dict[str, Any]] = {}
        parallel_rows: list[dict[str, Any]] = []
        parallel_by_stage: dict[str, list[dict[str, Any]]] = defaultdict(list)
        root_actor = str(agent_runs[0].actor or "") if agent_runs else ""

        for agent_row in agent_runs:
            agent_id = int(agent_row.id)
            llm_rows = llm_by_agent.get(agent_id, [])
            tool_rows = tool_by_agent.get(agent_id, [])
            output_row = output_map.get(agent_id, {})
            input_tokens = sum(int(item.input_tokens or 0) for item in llm_rows)
            output_tokens = sum(int(item.output_tokens or 0) for item in llm_rows)
            cached_input_tokens = sum(
                int(((item.usage_metadata_json or {}).get("cached_input_tokens", 0)) or 0)
                for item in llm_rows
            )
            new_input_tokens = sum(
                int(
                    (
                        (item.usage_metadata_json or {}).get(
                            "new_input_tokens",
                            max(
                                int(item.input_tokens or 0)
                                - int(
                                    ((item.usage_metadata_json or {}).get("cached_input_tokens", 0))
                                    or 0
                                ),
                                0,
                            ),
                        )
                    )
                    or 0
                )
                for item in llm_rows
            )
            total_cost = sum(float(item.estimated_total_cost_usd or 0.0) for item in llm_rows)
            stage_key = str(agent_row.agent_type or agent_row.actor or "unknown")
            status_value = normalize_run_display_status(
                str(agent_row.status or ""),
                failure_mode="",
                success=str(agent_row.status or "").strip().lower() == "success",
            )
            rollup = {
                "agent_run_id": agent_id,
                "actor": str(agent_row.actor or ""),
                "agent_type": stage_key,
                "status": status_value,
                "started_at": _json_ready(agent_row.started_at),
                "finished_at": _json_ready(agent_row.finished_at),
                "duration_seconds": float(agent_row.duration_seconds or 0.0),
                "tool_calls": len(tool_rows),
                "tool_calls_made": int(agent_row.tool_calls_made or 0),
                "llm_calls": len(llm_rows),
                "llm_calls_made": int(agent_row.llm_calls_made or 0),
                "invocation_index": int(agent_row.invocation_index or 0),
                "input_tokens": input_tokens,
                "cached_input_tokens": cached_input_tokens,
                "new_input_tokens": new_input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
                "cost_usd": round(total_cost, 6),
                "stream_count": int(output_row.get("stream_count", 0) or 0),
                "embedded_url_count": int(output_row.get("embedded_url_count", 0) or 0),
                "hosting_page_count": int(output_row.get("hosting_page_count", 0) or 0),
                "output_summary": str(output_row.get("summary_text", "") or ""),
                "raw_output": output_row.get("output_json", {}) or {},
            }
            agent_rollups.append(rollup)

            stage_entry = stage_rollups.setdefault(
                stage_key,
                {
                    "agent_type": stage_key,
                    "actors": set(),
                    "statuses": [],
                    "started_values": [],
                    "finished_values": [],
                    "duration_seconds": 0.0,
                    "tool_calls": 0,
                    "llm_calls": 0,
                    "input_tokens": 0,
                    "cached_input_tokens": 0,
                    "new_input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                    "cost_usd": 0.0,
                    "invocations": 0,
                    "stream_count": 0,
                    "output_summaries": [],
                },
            )
            stage_entry["actors"].add(str(agent_row.actor or ""))
            stage_entry["statuses"].append(status_value)
            if isinstance(agent_row.started_at, datetime):
                stage_entry["started_values"].append(agent_row.started_at)
            if isinstance(agent_row.finished_at, datetime):
                stage_entry["finished_values"].append(agent_row.finished_at)
            stage_entry["duration_seconds"] += float(agent_row.duration_seconds or 0.0)
            stage_entry["tool_calls"] += len(tool_rows)
            stage_entry["llm_calls"] += len(llm_rows)
            stage_entry["input_tokens"] += input_tokens
            stage_entry["cached_input_tokens"] += cached_input_tokens
            stage_entry["new_input_tokens"] += new_input_tokens
            stage_entry["output_tokens"] += output_tokens
            stage_entry["total_tokens"] += input_tokens + output_tokens
            stage_entry["cost_usd"] += total_cost
            stage_entry["invocations"] += 1
            stage_entry["stream_count"] += int(output_row.get("stream_count", 0) or 0)
            if output_row.get("summary_text"):
                stage_entry["output_summaries"].append(
                    str(output_row.get("summary_text", "") or "")
                )

            parallel_item = {
                "status": status_value,
                "started_at": agent_row.started_at,
                "finished_at": agent_row.finished_at,
            }
            parallel_rows.append(parallel_item)
            parallel_by_stage[stage_key].append(parallel_item)

        stage_rollup_rows = []
        for stage_key, values in stage_rollups.items():
            stage_rollup_rows.append(
                {
                    "agent_type": stage_key,
                    "actors": sorted([actor for actor in values["actors"] if actor]),
                    "status": _aggregate_agent_status(values["statuses"]),
                    "invocations": int(values["invocations"] or 0),
                    "started_at": _json_ready(min(values["started_values"]))
                    if values["started_values"]
                    else "",
                    "finished_at": _json_ready(max(values["finished_values"]))
                    if values["finished_values"]
                    else "",
                    "duration_seconds": round(float(values["duration_seconds"] or 0.0), 3),
                    "tool_calls": int(values["tool_calls"] or 0),
                    "llm_calls": int(values["llm_calls"] or 0),
                    "input_tokens": int(values["input_tokens"] or 0),
                    "cached_input_tokens": int(values["cached_input_tokens"] or 0),
                    "new_input_tokens": int(values["new_input_tokens"] or 0),
                    "output_tokens": int(values["output_tokens"] or 0),
                    "total_tokens": int(values["total_tokens"] or 0),
                    "cost_usd": round(float(values["cost_usd"] or 0.0), 6),
                    "stream_count": int(values["stream_count"] or 0),
                    "output_summary": "\n".join(values["output_summaries"][:3]),
                    "max_parallel_agents": _max_concurrency(parallel_by_stage.get(stage_key, [])),
                    "active_parallel_agents": len(
                        [
                            item
                            for item in parallel_by_stage.get(stage_key, [])
                            if item.get("finished_at") is None
                            and str(item.get("status", "") or "") in {"queued", "running"}
                        ]
                    ),
                }
            )

        job_state = self._job_state_row(job)
        run_payload = self._run_row(
            pipeline,
            root_actor=root_actor,
            job_status=str(job.status or "") if job is not None else "",
            max_parallel_agents=_max_concurrency(parallel_rows),
        )
        return {
            "run": run_payload,
            "snapshot": snapshot.snapshot_json if snapshot else {},
            "agent_runs": [self._serialize_model(row) for row in agent_runs],
            "agent_outputs": agent_output_rows,
            "agent_rollups": agent_rollups,
            "stage_rollups": stage_rollup_rows,
            "parallelism": {
                "current_parallel_agents": len(
                    [
                        item
                        for item in parallel_rows
                        if item.get("finished_at") is None
                        and str(item.get("status", "") or "") in {"queued", "running"}
                    ]
                ),
                "max_parallel_agents": _max_concurrency(parallel_rows),
                "by_stage": [
                    {
                        "agent_type": stage_key,
                        "current_parallel_agents": len(
                            [
                                item
                                for item in items
                                if item.get("finished_at") is None
                                and str(item.get("status", "") or "") in {"queued", "running"}
                            ]
                        ),
                        "max_parallel_agents": _max_concurrency(items),
                    }
                    for stage_key, items in parallel_by_stage.items()
                ],
            },
            "tool_calls": [self._serialize_model(row) for row in tool_calls],
            "llm_calls": [self._llm_row(row) for row in llm_calls],
            "events": [self._serialize_model(row) for row in events],
            "job": job_state,
            "job_state": job_state,
        }

    def ensure_default_evaluation_suites(self) -> list[EvaluationSuite]:
        suites = (
            self._session.query(EvaluationSuiteRecord)
            .order_by(EvaluationSuiteRecord.id.asc())
            .all()
        )
        if suites:
            return self.list_evaluation_suites()

        baseline = EvaluationSuiteRecord(
            name="Operator Baseline",
            description="Hybrid reliability suite for workflow success, hallucination checks, and tool usage discipline.",
            mode="hybrid",
            config_json={"recommended": True},
        )
        self._session.add(baseline)
        self._session.flush()
        self._session.add_all(
            [
                EvaluationCaseRecord(
                    suite_id=baseline.id,
                    name="Synthetic workflow sanity",
                    description="Checks a synthetic successful workflow artifact for evidence-backed output.",
                    mode="synthetic",
                    target_type="workflow",
                    input_json={
                        "artifact": {
                            "final_status": "success",
                            "all_streams": [{"url": "https://cdn.example.com/master.m3u8"}],
                            "provider_analysis": [{"provider": "Example CDN"}],
                            "takedown_emails": [{"abuse_email": "abuse@example.com"}],
                        },
                        "trace": {
                            "events": [
                                {"kind": "tool_call_started", "details": {"tool_name": "open_url"}},
                                {
                                    "kind": "tool_call_started",
                                    "details": {"tool_name": "capture_streams"},
                                },
                            ]
                        },
                    },
                    assertions_json={
                        "expected_final_status": "success",
                        "min_streams": 1,
                        "required_tools": ["open_url", "capture_streams"],
                        "forbidden_tools": ["delete_data"],
                    },
                ),
                EvaluationCaseRecord(
                    suite_id=baseline.id,
                    name="Mocked tool reliability",
                    description="Exercises tool reliability scoring against a mocked trace with one transient error.",
                    mode="mocked",
                    target_type="tool",
                    input_json={
                        "artifact": {"result": {"ok": True}},
                        "trace": {
                            "events": [
                                {
                                    "kind": "tool_call_started",
                                    "details": {"tool_name": "query_elements"},
                                },
                                {
                                    "kind": "tool_call_finished",
                                    "status": "error",
                                    "details": {"tool_name": "query_elements"},
                                },
                                {
                                    "kind": "tool_call_started",
                                    "details": {"tool_name": "query_elements"},
                                },
                                {
                                    "kind": "tool_call_finished",
                                    "status": "success",
                                    "details": {"tool_name": "query_elements"},
                                },
                            ]
                        },
                    },
                    assertions_json={
                        "required_tools": ["query_elements"],
                        "max_tool_errors": 1,
                    },
                ),
            ]
        )
        self._session.commit()
        return self.list_evaluation_suites()

    def list_evaluation_suites(self) -> list[EvaluationSuite]:
        suites = (
            self._session.query(EvaluationSuiteRecord)
            .order_by(EvaluationSuiteRecord.created_at.desc())
            .all()
        )
        result: list[EvaluationSuite] = []
        for suite in suites:
            cases = (
                self._session.query(EvaluationCaseRecord)
                .filter_by(suite_id=suite.id)
                .order_by(EvaluationCaseRecord.created_at.asc())
                .all()
            )
            result.append(
                EvaluationSuite(
                    id=suite.id,
                    name=suite.name,
                    description=suite.description,
                    mode=suite.mode,
                    active=suite.active,
                    config=suite.config_json or {},
                    cases=[
                        EvaluationCase(
                            id=case.id,
                            suite_id=suite.id,
                            name=case.name,
                            description=case.description,
                            mode=case.mode,
                            target_type=case.target_type,
                            active=case.active,
                            input=case.input_json or {},
                            assertions=case.assertions_json or {},
                            metadata=case.metadata_json or {},
                        )
                        for case in cases
                    ],
                )
            )
        return result

    def list_evaluation_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = (
            self._session.query(EvaluationRunRecord)
            .order_by(EvaluationRunRecord.started_at.desc())
            .limit(max(limit, 1))
            .all()
        )
        return [self._serialize_model(row) for row in rows]

    def create_evaluation_run(
        self, suite_id: int | None, name: str, mode: str, run_id: str
    ) -> EvaluationRunRecord:
        row = EvaluationRunRecord(
            suite_id=suite_id,
            run_id=run_id,
            name=name,
            mode=mode,
            status="running",
            started_at=datetime.utcnow(),
        )
        self._session.add(row)
        self._session.commit()
        self._session.refresh(row)
        return row

    def finalize_evaluation_run(
        self,
        run_id: str,
        *,
        case_results: list[EvaluationCaseResult],
        summary: dict[str, Any],
        status: str = "completed",
    ) -> EvaluationRun:
        row = self._session.query(EvaluationRunRecord).filter_by(run_id=run_id).first()
        if row is None:
            raise ValueError(f"Evaluation run '{run_id}' not found")

        self._session.query(EvaluationCaseResultRecord).filter_by(evaluation_run_id=row.id).delete()
        pass_count = 0
        for result in case_results:
            if result.status == "passed":
                pass_count += 1
            self._session.add(
                EvaluationCaseResultRecord(
                    evaluation_run_id=row.id,
                    case_id=result.case_id,
                    status=result.status,
                    target_type=result.target_type,
                    latency_ms=result.latency_ms,
                    total_cost_usd=result.total_cost_usd,
                    hallucination_score=result.hallucination_score,
                    tool_accuracy_score=result.tool_accuracy_score,
                    reliability_score=result.reliability_score,
                    assertion_results_json=[
                        item.model_dump(mode="json") for item in result.assertion_results
                    ],
                    output_json=result.output,
                    trace_json=result.trace,
                )
            )

        count = len(case_results)
        row.status = status
        row.case_count = count
        row.pass_count = pass_count
        row.success_rate = round(pass_count / count, 4) if count else 0.0
        row.hallucination_rate = (
            round(sum(1.0 - item.hallucination_score for item in case_results) / count, 4)
            if count
            else 0.0
        )
        row.tool_accuracy_rate = (
            round(sum(item.tool_accuracy_score for item in case_results) / count, 4)
            if count
            else 0.0
        )
        row.reliability_rate = (
            round(sum(item.reliability_score for item in case_results) / count, 4) if count else 0.0
        )
        row.avg_latency_ms = (
            round(sum(item.latency_ms for item in case_results) / count, 3) if count else 0.0
        )
        row.avg_cost_usd = (
            round(sum(item.total_cost_usd for item in case_results) / count, 6) if count else 0.0
        )
        row.summary_json = summary
        row.finished_at = datetime.utcnow()
        self._session.commit()
        return self.get_evaluation_run(run_id)

    def get_evaluation_run(self, run_id: str) -> EvaluationRun:
        row = self._session.query(EvaluationRunRecord).filter_by(run_id=run_id).first()
        if row is None:
            raise ValueError(f"Evaluation run '{run_id}' not found")
        case_rows = (
            self._session.query(EvaluationCaseResultRecord, EvaluationCaseRecord)
            .outerjoin(
                EvaluationCaseRecord, EvaluationCaseRecord.id == EvaluationCaseResultRecord.case_id
            )
            .filter(EvaluationCaseResultRecord.evaluation_run_id == row.id)
            .order_by(EvaluationCaseResultRecord.created_at.asc())
            .all()
        )
        return EvaluationRun(
            run_id=row.run_id,
            suite_id=row.suite_id,
            name=row.name,
            mode=row.mode,
            status=row.status,
            success_rate=row.success_rate,
            hallucination_rate=row.hallucination_rate,
            tool_accuracy_rate=row.tool_accuracy_rate,
            reliability_rate=row.reliability_rate,
            avg_latency_ms=row.avg_latency_ms,
            avg_cost_usd=row.avg_cost_usd,
            case_count=row.case_count,
            pass_count=row.pass_count,
            summary=row.summary_json or {},
            case_results=[
                EvaluationCaseResult(
                    case_id=case.id if case else result.case_id,
                    case_name=case.name if case else "",
                    status=result.status,
                    target_type=result.target_type,
                    latency_ms=result.latency_ms,
                    total_cost_usd=result.total_cost_usd,
                    hallucination_score=result.hallucination_score,
                    tool_accuracy_score=result.tool_accuracy_score,
                    reliability_score=result.reliability_score,
                    assertion_results=result.assertion_results_json or [],
                    output=result.output_json or {},
                    trace=result.trace_json or {},
                )
                for result, case in case_rows
            ],
        )

    def record_tool_playground_call(
        self,
        *,
        call_id: str,
        profile: str,
        tool_name: str,
        args: dict[str, Any],
        status: str,
        duration_seconds: float,
        result: dict[str, Any] | None = None,
        error_text: str = "",
        origin: str = "playground",
        related_run_id: str = "",
    ) -> dict[str, Any]:
        row = ToolPlaygroundCallRecord(
            call_id=call_id,
            origin=origin,
            related_run_id=related_run_id,
            profile=profile,
            tool_name=tool_name,
            status=status,
            duration_seconds=duration_seconds,
            args_json=args or {},
            result_json=result or {},
            error_text=error_text,
        )
        self._session.add(row)
        self._session.commit()
        self._session.refresh(row)
        return self._serialize_model(row)

    def list_tool_playground_calls(
        self,
        *,
        limit: int = 20,
        offset: int = 0,
        profile: str = "",
        origin: str = "",
    ) -> dict[str, Any]:
        query = self._session.query(ToolPlaygroundCallRecord)
        if profile:
            query = query.filter(ToolPlaygroundCallRecord.profile == profile)
        if origin:
            query = query.filter(ToolPlaygroundCallRecord.origin == origin)
        total = query.count()
        rows = (
            query.order_by(ToolPlaygroundCallRecord.created_at.desc())
            .offset(max(offset, 0))
            .limit(max(limit, 1))
            .all()
        )
        return {
            "total": total,
            "rows": [self._serialize_model(row) for row in rows],
        }

    def record_provider_lookup_batch(
        self, lookup_id: str, results: list[ProviderInfo]
    ) -> list[dict[str, Any]]:
        rows: list[ProviderLookupCheckRecord] = []
        for result in results:
            row = ProviderLookupCheckRecord(
                lookup_id=lookup_id,
                stream_url=result.stream_url,
                hostname=result.hostname,
                ip=result.ip,
                org=result.org,
                provider=result.provider,
                country=result.country,
                region=result.region,
                city=result.city,
                abuse_email=result.abuse_email,
                whois_raw=result.whois_raw,
            )
            rows.append(row)
            self._session.add(row)
        self._session.commit()
        payloads = []
        for row in rows:
            payload = self._serialize_model(row)
            code = country_code_from_value(str(row.country or ""))
            payload["country_code"] = code
            payload["flag"] = flag_emoji_from_country_code(code)
            payloads.append(payload)
        return payloads

    def get_provider_lookup_history(self, *, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        query = self._session.query(ProviderLookupCheckRecord)
        total = query.count()
        rows = (
            query.order_by(
                ProviderLookupCheckRecord.created_at.desc(), ProviderLookupCheckRecord.id.desc()
            )
            .offset(max(offset, 0))
            .limit(max(limit, 1))
            .all()
        )
        top_providers = (
            self._session.query(
                ProviderLookupCheckRecord.provider,
                func.count(ProviderLookupCheckRecord.id),
            )
            .filter(ProviderLookupCheckRecord.provider != "")
            .group_by(ProviderLookupCheckRecord.provider)
            .order_by(
                func.count(ProviderLookupCheckRecord.id).desc(),
                ProviderLookupCheckRecord.provider.asc(),
            )
            .limit(8)
            .all()
        )
        top_countries = (
            self._session.query(
                ProviderLookupCheckRecord.country,
                func.count(ProviderLookupCheckRecord.id),
            )
            .filter(ProviderLookupCheckRecord.country != "")
            .group_by(ProviderLookupCheckRecord.country)
            .order_by(
                func.count(ProviderLookupCheckRecord.id).desc(),
                ProviderLookupCheckRecord.country.asc(),
            )
            .limit(8)
            .all()
        )
        summary = self._session.query(
            func.count(ProviderLookupCheckRecord.id),
            func.coalesce(func.sum(case((ProviderLookupCheckRecord.ip != "", 1), else_=0)), 0),
            func.coalesce(
                func.sum(case((ProviderLookupCheckRecord.provider != "", 1), else_=0)), 0
            ),
            func.coalesce(
                func.sum(case((ProviderLookupCheckRecord.abuse_email != "", 1), else_=0)), 0
            ),
            func.count(
                func.distinct(
                    case(
                        (
                            ProviderLookupCheckRecord.provider != "",
                            ProviderLookupCheckRecord.provider,
                        ),
                        else_=None,
                    )
                )
            ),
            func.count(
                func.distinct(
                    case(
                        (
                            ProviderLookupCheckRecord.hostname != "",
                            ProviderLookupCheckRecord.hostname,
                        ),
                        else_=None,
                    )
                )
            ),
        ).one()
        serialized_rows = []
        for row in rows:
            payload = self._serialize_model(row)
            code = country_code_from_value(str(row.country or ""))
            payload["country_code"] = code
            payload["flag"] = flag_emoji_from_country_code(code)
            serialized_rows.append(payload)
        top_country_rows = []
        for country, count in top_countries:
            code = country_code_from_value(str(country or ""))
            top_country_rows.append(
                {
                    "country": country,
                    "country_code": code,
                    "flag": flag_emoji_from_country_code(code),
                    "count": int(count or 0),
                }
            )
        return {
            "total": total,
            "rows": serialized_rows,
            "summary": {
                "total_checks": int(summary[0] or 0),
                "resolved_ips": int(summary[1] or 0),
                "provider_matches": int(summary[2] or 0),
                "abuse_contacts_found": int(summary[3] or 0),
                "unique_providers": int(summary[4] or 0),
                "unique_hosts": int(summary[5] or 0),
            },
            "top_providers": [
                {"provider": provider, "count": int(count or 0)}
                for provider, count in top_providers
            ],
            "top_countries": top_country_rows,
            "country_map": {
                "points": top_country_rows,
                "covered_country_codes": [
                    row["country_code"] for row in top_country_rows if row.get("country_code")
                ],
            },
        }

    def list_recent_runtime_events(self, *, limit: int = 30) -> list[dict[str, Any]]:
        rows = (
            self._session.query(RuntimeEventRecord)
            .order_by(RuntimeEventRecord.created_at.desc(), RuntimeEventRecord.id.desc())
            .limit(max(limit, 1))
            .all()
        )
        payloads = [self._serialize_model(row) for row in rows]
        payloads.reverse()
        return payloads

    def list_database_table(
        self, table: str, *, limit: int = 50, offset: int = 0
    ) -> dict[str, Any]:
        model = self.TABLE_MAP.get(table)
        if model is None:
            raise ValueError(f"Unknown table '{table}'")
        query = self._session.query(model)
        total = query.count()
        rows = query.offset(max(offset, 0)).limit(max(limit, 1)).all()
        columns = [column.name for column in model.__table__.columns]
        return {
            "table": table,
            "columns": columns,
            "rows": [self._serialize_model(row) for row in rows],
            "limit": limit,
            "offset": offset,
            "total": total,
        }

    def _job_state_row(self, row: BackgroundJobRecord | None) -> dict[str, Any] | None:
        if row is None:
            return None
        display_status = normalize_job_display_status(str(row.status or ""))
        return {
            "job_id": str(row.job_id or ""),
            "run_id": str(row.run_id or ""),
            "job_type": str(row.job_type or ""),
            "actor": str(row.actor or ""),
            "status": str(row.status or ""),
            "display_status": display_status,
            "attempts": int(row.attempts or 0),
            "max_attempts": int(row.max_attempts or 0),
            "error_text": str(row.error_text or ""),
            "created_at": _json_ready(row.created_at),
            "started_at": _json_ready(row.started_at),
            "finished_at": _json_ready(row.finished_at),
            "heartbeat_at": _json_ready(row.heartbeat_at),
        }

    def _run_row(
        self,
        row: PipelineRunRecord,
        *,
        root_actor: str = "",
        job_status: str = "",
        max_parallel_agents: int = 0,
    ) -> dict[str, Any]:
        total_cost = float(row.estimated_total_cost_usd or 0.0)
        display_status = normalize_run_display_status(
            str(row.final_status or ""),
            success=bool(row.success),
            failure_mode=str(row.failure_mode or ""),
            job_status=job_status,
        )
        return {
            "run_id": row.run_id,
            "url": row.root_url,
            "page_type": row.page_type,
            "status": display_status,
            "final_status": display_status,
            "persisted_final_status": row.final_status,
            "success": row.success,
            "stream_count": row.stream_count,
            "screenshot_count": row.screenshot_count,
            "email_count": row.email_count,
            "provider_analysis_count": row.provider_analysis_count,
            "total_tokens_in": row.total_tokens_in,
            "total_tokens_out": row.total_tokens_out,
            "total_llm_calls": row.total_llm_calls,
            "total_tool_calls": row.total_tool_calls,
            "estimated_total_cost_usd": total_cost,
            "total_cost_usd": total_cost,
            "duration_seconds": float(row.duration_seconds or 0.0),
            "failure_mode": row.failure_mode or "",
            "top_level_page_type": row.top_level_page_type or "",
            "root_actor": root_actor,
            "started_at": _json_ready(row.started_at),
            "finished_at": _json_ready(row.finished_at),
            "job_state": normalize_job_display_status(job_status) if job_status else "",
            "max_parallel_agents": int(max_parallel_agents or 0),
            "created_at": row.created_at.isoformat(),
        }

    def _llm_row(self, row: LLMCallRecord) -> dict[str, Any]:
        payload = self._serialize_model(row)
        total_cost = float(payload.get("estimated_total_cost_usd", 0.0) or 0.0)
        payload["total_cost_usd"] = total_cost
        payload["cost_source"] = str(
            (payload.get("usage_metadata_json", {}) or {}).get("cost_source", "") or ""
        )
        return payload

    def _serialize_model(self, row: Any) -> dict[str, Any]:
        return {
            column.name: _json_ready(getattr(row, column.name)) for column in row.__table__.columns
        }

    def _merged_model_usage_rows(
        self, *, limit: int = 12
    ) -> tuple[list[dict[str, Any]], dict[str, int]]:
        aggregated: dict[tuple[str, str], dict[str, float]] = defaultdict(
            lambda: {
                "calls": 0.0,
                "input_tokens": 0.0,
                "output_tokens": 0.0,
                "cached_input_tokens": 0.0,
                "new_input_tokens": 0.0,
                "cost": 0.0,
            }
        )

        model_usage_rows = (
            self._session.query(
                RunModelUsageRecord.provider,
                RunModelUsageRecord.model_name,
                func.coalesce(func.sum(RunModelUsageRecord.llm_calls), 0),
                func.coalesce(func.sum(RunModelUsageRecord.input_tokens), 0),
                func.coalesce(func.sum(RunModelUsageRecord.output_tokens), 0),
                func.coalesce(func.sum(RunModelUsageRecord.estimated_total_cost_usd), 0.0),
            )
            .group_by(RunModelUsageRecord.provider, RunModelUsageRecord.model_name)
            .all()
        )
        for provider, model_name, calls, input_tokens, output_tokens, cost in model_usage_rows:
            key = ((provider or "unknown") or "unknown", (model_name or "unknown") or "unknown")
            aggregated[key]["calls"] += int(calls or 0)
            aggregated[key]["input_tokens"] += int(input_tokens or 0)
            aggregated[key]["output_tokens"] += int(output_tokens or 0)
            aggregated[key]["cost"] += float(cost or 0.0)
        runtime_rows = self._runtime_llm_rollup()
        for (
            provider,
            model_name,
            calls,
            input_tokens,
            output_tokens,
            cached_input_tokens,
            new_input_tokens,
            cost,
        ) in runtime_rows:
            key = ((provider or "unknown") or "unknown", (model_name or "unknown") or "unknown")
            if key not in aggregated:
                aggregated[key]["calls"] += int(calls or 0)
                aggregated[key]["input_tokens"] += int(input_tokens or 0)
                aggregated[key]["output_tokens"] += int(output_tokens or 0)
                aggregated[key]["cost"] += float(cost or 0.0)
            aggregated[key]["cached_input_tokens"] += int(cached_input_tokens or 0)
            aggregated[key]["new_input_tokens"] += int(new_input_tokens or 0)

        rows: list[dict[str, Any]] = []
        totals = {"cached_input_tokens": 0, "new_input_tokens": 0}
        for (provider, model_name), values in aggregated.items():
            input_tokens = int(values["input_tokens"])
            output_tokens = int(values["output_tokens"])
            cached_input_tokens = int(values["cached_input_tokens"])
            new_input_tokens = int(values["new_input_tokens"])
            rows.append(
                {
                    "label": f"{provider or 'unknown'}::{model_name or 'unknown'}",
                    "provider": provider or "unknown",
                    "model_name": model_name or "unknown",
                    "calls": int(values["calls"]),
                    "tokens": input_tokens + output_tokens,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cached_input_tokens": cached_input_tokens,
                    "new_input_tokens": new_input_tokens,
                    "cost_usd": round(float(values["cost"] or 0.0), 6),
                }
            )
            totals["cached_input_tokens"] += cached_input_tokens
            totals["new_input_tokens"] += new_input_tokens

        rows.sort(
            key=lambda item: (
                -float(item.get("cost_usd", 0.0) or 0.0),
                -int(item.get("calls", 0) or 0),
                item.get("model_name", ""),
            )
        )
        return rows[: max(limit, 1)], totals

    def _runtime_llm_rollup(self) -> list[tuple[str, str, int, int, int, int, int, float]]:
        query = self._session.query(RuntimeEventRecord.details_json).filter(
            RuntimeEventRecord.kind == "llm_response"
        )

        aggregated: dict[tuple[str, str], dict[str, float]] = defaultdict(
            lambda: {
                "calls": 0.0,
                "input_tokens": 0.0,
                "output_tokens": 0.0,
                "cached_input_tokens": 0.0,
                "new_input_tokens": 0.0,
                "cost": 0.0,
            }
        )

        for (details_json,) in query.all():
            details = details_json if isinstance(details_json, dict) else {}
            provider = str(details.get("provider", "") or "unknown")
            model_name = str(details.get("model_name", "") or "unknown")
            input_tokens = int(details.get("input_tokens", 0) or 0)
            output_tokens = int(details.get("output_tokens", 0) or 0)
            cached_input_tokens = int(details.get("cached_input_tokens", 0) or 0)
            new_input_tokens = int(
                details.get("new_input_tokens", max(input_tokens - cached_input_tokens, 0)) or 0
            )
            estimated_total_cost_usd = float(details.get("estimated_total_cost_usd", 0.0) or 0.0)

            key = (provider, model_name)
            aggregated[key]["calls"] += 1
            aggregated[key]["input_tokens"] += input_tokens
            aggregated[key]["output_tokens"] += output_tokens
            aggregated[key]["cached_input_tokens"] += cached_input_tokens
            aggregated[key]["new_input_tokens"] += new_input_tokens
            aggregated[key]["cost"] += estimated_total_cost_usd

        rows = [
            (
                provider,
                model_name,
                int(values["calls"]),
                int(values["input_tokens"]),
                int(values["output_tokens"]),
                int(values["cached_input_tokens"]),
                int(values["new_input_tokens"]),
                float(values["cost"]),
            )
            for (provider, model_name), values in aggregated.items()
        ]
        rows.sort(key=lambda item: (-float(item[7] or 0.0), -int(item[2] or 0), item[1]))
        return rows

    def _merged_top_tool_rows(self, *, limit: int = 10) -> list[tuple[str, int, int, int, float]]:
        rows = (
            self._session.query(
                ToolCallRecord.tool_name,
                func.count(ToolCallRecord.id),
                func.coalesce(func.sum(case((ToolCallRecord.status == "success", 1), else_=0)), 0),
                func.coalesce(func.sum(case((ToolCallRecord.status == "error", 1), else_=0)), 0),
                func.coalesce(func.avg(ToolCallRecord.duration_seconds), 0.0),
            )
            .group_by(ToolCallRecord.tool_name)
            .all()
        )

        aggregated: dict[str, dict[str, float]] = defaultdict(
            lambda: {
                "calls": 0.0,
                "successes": 0.0,
                "errors": 0.0,
                "duration_sum": 0.0,
                "duration_count": 0.0,
            }
        )
        for tool_name, count, successes, errors, avg_duration in rows:
            key = str(tool_name or "unknown")
            calls = int(count or 0)
            aggregated[key]["calls"] += calls
            aggregated[key]["successes"] += int(successes or 0)
            aggregated[key]["errors"] += int(errors or 0)
            aggregated[key]["duration_sum"] += float(avg_duration or 0.0) * calls
            aggregated[key]["duration_count"] += calls

        pipeline_ids_with_tool_rows = {
            int(pipeline_id)
            for (pipeline_id,) in (
                self._session.query(AgentRunRecord.pipeline_run_id)
                .join(ToolCallRecord, ToolCallRecord.agent_run_id == AgentRunRecord.id)
                .distinct()
                .all()
            )
        }
        fallback_rows = self._runtime_tool_rows(excluded_pipeline_ids=pipeline_ids_with_tool_rows)
        for tool_name, calls, successes, errors, avg_duration, duration_count in fallback_rows:
            key = str(tool_name or "unknown")
            aggregated[key]["calls"] += int(calls or 0)
            aggregated[key]["successes"] += int(successes or 0)
            aggregated[key]["errors"] += int(errors or 0)
            aggregated[key]["duration_sum"] += float(avg_duration or 0.0) * int(duration_count or 0)
            aggregated[key]["duration_count"] += int(duration_count or 0)

        merged_rows: list[tuple[str, int, int, int, float]] = []
        for tool_name, values in aggregated.items():
            duration_count = int(values["duration_count"])
            avg_duration = (
                (float(values["duration_sum"]) / duration_count) if duration_count else 0.0
            )
            merged_rows.append(
                (
                    tool_name,
                    int(values["calls"]),
                    int(values["successes"]),
                    int(values["errors"]),
                    avg_duration,
                )
            )
        merged_rows.sort(key=lambda item: (-int(item[1] or 0), item[0]))
        return merged_rows[: max(limit, 1)]

    def _runtime_tool_rows(
        self, *, excluded_pipeline_ids: set[int]
    ) -> list[tuple[str, int, int, int, float, int]]:
        query = self._session.query(
            RuntimeEventRecord.pipeline_run_id,
            RuntimeEventRecord.status,
            RuntimeEventRecord.details_json,
        ).filter(RuntimeEventRecord.kind == "tool_call_finished")
        if excluded_pipeline_ids:
            query = query.filter(~RuntimeEventRecord.pipeline_run_id.in_(excluded_pipeline_ids))

        aggregated: dict[str, dict[str, float]] = defaultdict(
            lambda: {
                "calls": 0.0,
                "successes": 0.0,
                "errors": 0.0,
                "duration_sum": 0.0,
                "duration_count": 0.0,
            }
        )
        for _, event_status, details_json in query.all():
            details = details_json if isinstance(details_json, dict) else {}
            tool_name = str(details.get("tool_name", "") or "unknown")
            status = str(details.get("status", "") or event_status or "info").strip().lower()
            duration = float(details.get("duration_seconds", 0.0) or 0.0)

            aggregated[tool_name]["calls"] += 1
            if status == "success":
                aggregated[tool_name]["successes"] += 1
            elif status in {"error", "failed", "fail"}:
                aggregated[tool_name]["errors"] += 1
            aggregated[tool_name]["duration_sum"] += duration
            aggregated[tool_name]["duration_count"] += 1

        rows: list[tuple[str, int, int, int, float, int]] = []
        for tool_name, values in aggregated.items():
            duration_count = int(values["duration_count"])
            avg_duration = (
                (float(values["duration_sum"]) / duration_count) if duration_count else 0.0
            )
            rows.append(
                (
                    tool_name,
                    int(values["calls"]),
                    int(values["successes"]),
                    int(values["errors"]),
                    avg_duration,
                    duration_count,
                )
            )
        rows.sort(key=lambda item: (-int(item[1] or 0), item[0]))
        return rows

    def _runtime_tool_rollup(self, *, excluded_pipeline_ids: set[int]) -> dict[str, float]:
        rows = self._runtime_tool_rows(excluded_pipeline_ids=excluded_pipeline_ids)
        calls = sum(int(row[1] or 0) for row in rows)
        successes = sum(int(row[2] or 0) for row in rows)
        errors = sum(int(row[3] or 0) for row in rows)
        duration_count = sum(int(row[5] or 0) for row in rows)
        duration_sum = sum(float(row[4] or 0.0) * int(row[5] or 0) for row in rows)
        return {
            "calls": calls,
            "successes": successes,
            "errors": errors,
            "duration_count": duration_count,
            "duration_sum": duration_sum,
        }

    def _daily_trend(self, *, window_days: int = 7) -> list[dict[str, Any]]:
        start_date = datetime.utcnow().date() - timedelta(days=max(window_days - 1, 0))
        buckets = {
            (start_date + timedelta(days=index)).strftime("%Y-%m-%d"): {
                "date": (start_date + timedelta(days=index)).strftime("%Y-%m-%d"),
                "runs": 0,
                "successes": 0,
                "partials": 0,
                "running": 0,
                "failures": 0,
                "tokens": 0,
                "cost_usd": 0.0,
                "avg_latency_seconds": 0.0,
            }
            for index in range(window_days)
        }
        rows = (
            self._session.query(
                func.date(PipelineRunRecord.created_at),
                func.count(PipelineRunRecord.id),
                func.coalesce(
                    func.sum(case((PipelineRunRecord.final_status == "success", 1), else_=0)), 0
                ),
                func.coalesce(
                    func.sum(case((PipelineRunRecord.final_status == "partial", 1), else_=0)), 0
                ),
                func.coalesce(
                    func.sum(case((PipelineRunRecord.final_status == "failed", 1), else_=0)), 0
                ),
                func.coalesce(
                    func.sum(case((PipelineRunRecord.final_status == "running", 1), else_=0)), 0
                ),
                func.coalesce(
                    func.sum(
                        PipelineRunRecord.total_tokens_in + PipelineRunRecord.total_tokens_out
                    ),
                    0,
                ),
                func.coalesce(func.sum(PipelineRunRecord.estimated_total_cost_usd), 0.0),
                func.coalesce(func.avg(PipelineRunRecord.duration_seconds), 0.0),
            )
            .filter(
                PipelineRunRecord.created_at >= datetime.combine(start_date, datetime.min.time())
            )
            .group_by(func.date(PipelineRunRecord.created_at))
            .all()
        )
        for (
            row_date,
            runs,
            successes,
            partials,
            failures,
            running,
            tokens,
            cost,
            avg_latency,
        ) in rows:
            key = self._normalize_day_key(row_date)
            bucket = buckets.get(key)
            if bucket is None:
                continue
            bucket["runs"] = int(runs or 0)
            bucket["successes"] = int(successes or 0)
            bucket["partials"] = int(partials or 0) + int(running or 0)
            bucket["running"] = int(running or 0)
            bucket["failures"] = int(failures or 0)
            bucket["tokens"] = int(tokens or 0)
            bucket["cost_usd"] = round(float(cost or 0.0), 6)
            bucket["avg_latency_seconds"] = round(float(avg_latency or 0.0), 3)
        return list(buckets.values())

    def _normalize_day_key(self, row_date: Any) -> str:
        if isinstance(row_date, datetime):
            return row_date.strftime("%Y-%m-%d")
        if isinstance(row_date, date):
            return row_date.isoformat()
        return str(row_date)
