"""CRUD operations for legacy snapshots and normalized observability storage."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sqlalchemy.orm import Session

from src.memory.long_term import build_site_memory_entry
from src.models.enums import AgentType
from src.models.schemas import PipelineResult
from src.storage.models import (
    AgentOutputRecord,
    AgentRunRecord,
    LLMCallRecord,
    MemoryEntryRecord,
    MemoryHintUsedRecord,
    PipelineRunRecord,
    PromptCompilationRecord,
    PromptVersionRecord,
    ProviderAnalysisRecord,
    RunModelUsageRecord,
    RunRecord,
    RunScreenshotRecord,
    RunSnapshotRecord,
    RunStreamRecord,
    RuntimeEventRecord,
    TakedownEmailRecord,
    ToolCallRecord,
)
from src.utils.observability import RunTrace

_PROMPT_PATHS = {
    AgentType.CLASSIFICATION.value: Path("configs/prompts/classification_v1.md"),
    AgentType.LANDING_PAGE.value: Path("configs/prompts/landing_page_v1.md"),
    AgentType.HOSTING_PAGE.value: Path("configs/prompts/hosting_page_v1.md"),
    AgentType.EMBEDDED_PAGE.value: Path("configs/prompts/embedded_page_v1.md"),
}

_ACTOR_TO_AGENT_TYPE = {
    "classification": AgentType.CLASSIFICATION.value,
    "landing": AgentType.LANDING_PAGE.value,
    "hosting": AgentType.HOSTING_PAGE.value,
    "embedded": AgentType.EMBEDDED_PAGE.value,
    "orchestrator": AgentType.ORCHESTRATOR.value,
}


class RunRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def save(self, result: PipelineResult, trace: RunTrace | None = None) -> RunRecord:
        txn = self._session.begin_nested() if self._session.in_transaction() else self._session.begin()
        with txn:
            record = self._upsert_legacy_run(result)
            pipeline = self._upsert_pipeline_run(result)
            self._session.flush()
            self._upsert_run_snapshot(pipeline, result)
            self._replace_normalized_children(pipeline.id)
            agent_runs = self._persist_agent_runs(pipeline.id, result, trace)
            self._persist_runtime_events(pipeline.id, trace, agent_runs)
            self._persist_run_model_usage(pipeline.id, result)
            self._persist_run_streams(pipeline.id, result)
            self._persist_run_screenshots(pipeline.id, result)
            self._persist_provider_analyses(pipeline.id, result)
            self._persist_takedown_emails(pipeline.id, result)
            self._persist_memory_entries(result.run_id, pipeline.id, agent_runs, result, trace)
            self._persist_memory_hints_used(result.run_id, agent_runs)
        self._session.refresh(record)
        return record

    def get_by_run_id(self, run_id: str) -> RunRecord | None:
        return self._session.query(RunRecord).filter_by(run_id=run_id).first()

    def list_recent(self, limit: int = 50) -> list[RunRecord]:
        return (
            self._session.query(RunRecord)
            .order_by(RunRecord.created_at.desc())
            .limit(limit)
            .all()
        )

    def success_rate(self) -> float:
        total = self._session.query(PipelineRunRecord).count()
        if total:
            successes = self._session.query(PipelineRunRecord).filter_by(success=True).count()
            return successes / total
        total = self._session.query(RunRecord).count()
        if total == 0:
            return 0.0
        successes = self._session.query(RunRecord).filter_by(success=True).count()
        return successes / total

    def get_run_snapshot(self, run_id: str) -> dict[str, Any] | None:
        snapshot = self._session.query(RunSnapshotRecord).filter_by(run_id=run_id).first()
        if snapshot is not None:
            return snapshot.snapshot_json or {}
        record = self.get_by_run_id(run_id)
        return record.result_json if record is not None else None

    def get_run_emails(self, run_id: str) -> dict[str, Any] | None:
        snapshot = self.get_run_snapshot(run_id)
        if snapshot is None:
            return None
        return {
            "run_id": run_id,
            "url": snapshot.get("url", ""),
            "emails": snapshot.get("takedown_emails", []),
        }

    def get_observability_summary(self, limit: int = 10) -> dict[str, Any]:
        recent = (
            self._session.query(PipelineRunRecord)
            .order_by(PipelineRunRecord.created_at.desc())
            .limit(limit)
            .all()
        )
        return {
            "success_rate": self.success_rate(),
            "run_count": len(recent),
            "recent_runs": [
                {
                    "run_id": run.run_id,
                    "url": run.root_url,
                    "status": run.final_status,
                    "success": run.success,
                    "streams_found": run.stream_count,
                    "tool_calls": run.total_tool_calls,
                    "tokens_in": run.total_tokens_in,
                    "tokens_out": run.total_tokens_out,
                    "estimated_total_cost_usd": run.estimated_total_cost_usd,
                    "llm_calls": run.total_llm_calls,
                    "message_count": run.total_messages,
                    "duration_seconds": run.duration_seconds,
                    "created_at": run.created_at.isoformat(),
                }
                for run in recent
            ],
        }

    def list_agent_runs(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(AgentRunRecord)
            .filter_by(pipeline_run_id=pipeline.id)
            .order_by(AgentRunRecord.started_at.asc(), AgentRunRecord.id.asc())
            .all()
        )
        return [
            {
                "id": row.id,
                "actor": row.actor,
                "agent_type": row.agent_type,
                "target_url": row.target_url,
                "page_type": row.page_type,
                "status": row.status,
                "tool_call_budget": row.tool_call_budget,
                "tool_calls_made": row.tool_calls_made,
                "llm_calls_made": row.llm_calls_made,
                "memory_injected": row.memory_injected,
                "started_at": row.started_at.isoformat(),
                "finished_at": row.finished_at.isoformat() if row.finished_at else None,
                "duration_seconds": row.duration_seconds,
            }
            for row in rows
        ]

    def list_llm_calls(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(LLMCallRecord)
            .join(AgentRunRecord, AgentRunRecord.id == LLMCallRecord.agent_run_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(AgentRunRecord.started_at.asc(), LLMCallRecord.seq.asc())
            .all()
        )
        return [
            {
                "agent_run_id": row.agent_run_id,
                "seq": row.seq,
                "provider": row.provider,
                "model_name": row.model_name,
                "prompt_version": row.prompt_version,
                "prompt_hash": row.prompt_hash,
                "cache_mode": row.cache_mode,
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "estimated_total_cost_usd": row.estimated_total_cost_usd,
                "tool_calls_requested": row.tool_calls_requested,
                "tools_requested": row.tools_requested,
                "content_preview": row.content_preview,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]

    def list_tool_calls(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(ToolCallRecord)
            .join(AgentRunRecord, AgentRunRecord.id == ToolCallRecord.agent_run_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(AgentRunRecord.started_at.asc(), ToolCallRecord.seq.asc())
            .all()
        )
        return [
            {
                "agent_run_id": row.agent_run_id,
                "seq": row.seq,
                "tool_name": row.tool_name,
                "target_summary": row.target_summary,
                "status": row.status,
                "duration_seconds": row.duration_seconds,
                "result_preview": row.result_preview,
                "error_text": row.error_text,
                "created_at": row.started_at.isoformat(),
            }
            for row in rows
        ]

    def list_runtime_events(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(RuntimeEventRecord)
            .filter_by(pipeline_run_id=pipeline.id)
            .order_by(RuntimeEventRecord.seq.asc())
            .all()
        )
        return [
            {
                "seq": row.seq,
                "actor": row.actor,
                "kind": row.kind,
                "status": row.status,
                "message": row.message,
                "details": row.details_json,
                "created_at": row.created_at.isoformat(),
                "agent_run_id": row.agent_run_id,
            }
            for row in rows
        ]

    def list_memory_entries(
        self,
        *,
        domain: str | None = None,
        page_type: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        query = self._session.query(MemoryEntryRecord)
        if domain:
            query = query.filter(MemoryEntryRecord.domain == domain)
        if page_type:
            query = query.filter(MemoryEntryRecord.page_type == page_type)
        rows = query.order_by(MemoryEntryRecord.created_at.desc()).limit(limit).all()
        return [
            {
                "id": row.id,
                "domain": row.domain,
                "page_type": row.page_type,
                "source_run_id": row.source_run_id,
                "source_agent_run_id": row.source_agent_run_id,
                "status": row.status,
                "success": row.success,
                "url": row.url,
                "data": row.data_json,
                "result_summary": row.result_summary,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]

    def list_prompt_compilations(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(PromptCompilationRecord, PromptVersionRecord)
            .join(AgentRunRecord, AgentRunRecord.id == PromptCompilationRecord.agent_run_id)
            .outerjoin(PromptVersionRecord, PromptVersionRecord.id == PromptCompilationRecord.prompt_version_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(PromptCompilationRecord.created_at.asc())
            .all()
        )
        return [
            {
                "agent_run_id": compilation.agent_run_id,
                "agent_id": prompt_version.agent_id if prompt_version else "",
                "source_path": prompt_version.source_path if prompt_version else "",
                "prompt_version": prompt_version.semantic_version if prompt_version else "",
                "prompt_hash": prompt_version.content_hash if prompt_version else "",
                "cache_mode": compilation.cache_mode,
                "compiled_prompt_hash": compilation.compiled_prompt_hash,
                "provider_cache_key": compilation.provider_cache_key,
                "provider_cache_eligible": compilation.provider_cache_eligible,
                "memory_injected": compilation.memory_injected,
                "sections": compilation.sections_json,
                "metadata": compilation.metadata_json,
            }
            for compilation, prompt_version in rows
        ]

    def backfill_normalized_from_legacy(self, limit: int | None = None) -> int:
        query = (
            self._session.query(RunRecord)
            .outerjoin(PipelineRunRecord, PipelineRunRecord.run_id == RunRecord.run_id)
            .filter(PipelineRunRecord.id.is_(None))
            .order_by(RunRecord.created_at.asc())
        )
        if limit:
            query = query.limit(limit)
        count = 0
        for record in query.all():
            payload = record.result_json or {}
            if not payload:
                continue
            try:
                result = PipelineResult.model_validate(payload)
            except Exception:
                continue
            self.save(result, trace=None)
            count += 1
        return count

    def _upsert_legacy_run(self, result: PipelineResult) -> RunRecord:
        record = self.get_by_run_id(result.run_id)
        if record is None:
            record = RunRecord(run_id=result.run_id)
            self._session.add(record)
        record.url = result.url
        record.page_type = result.classification.page_type.value if result.classification else "unknown"
        record.status = result.final_status.value
        record.streams_found = len(result.all_streams)
        record.success = result.final_status.value == "success"
        record.result_json = result.model_dump(mode="json")
        if result.metrics:
            record.tokens_in = result.metrics.total_tokens_in
            record.tokens_out = result.metrics.total_tokens_out
            record.tool_calls = result.metrics.total_tool_calls
            record.duration_seconds = result.metrics.total_duration_seconds
            record.failure_mode = result.metrics.failure_mode
        return record

    def _upsert_pipeline_run(self, result: PipelineResult) -> PipelineRunRecord:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=result.run_id).first()
        if pipeline is None:
            pipeline = PipelineRunRecord(run_id=result.run_id)
            self._session.add(pipeline)
        metrics = result.metrics
        pipeline.root_url = result.url
        pipeline.page_type = result.classification.page_type.value if result.classification else "unknown"
        pipeline.final_status = result.final_status.value
        pipeline.success = result.final_status.value == "success"
        pipeline.failure_mode = metrics.failure_mode if metrics else ""
        pipeline.stream_count = len(result.all_streams)
        pipeline.screenshot_count = len(result.all_screenshots)
        pipeline.email_count = len(result.takedown_emails)
        pipeline.provider_analysis_count = len(result.provider_analysis)
        pipeline.top_level_page_type = result.classification.page_type.value if result.classification else "unknown"
        pipeline.classification_confidence = result.classification.confidence.value if result.classification else ""
        pipeline.classification_reasoning = result.classification.reasoning if result.classification else ""
        pipeline.started_at = metrics.started_at if metrics else pipeline.started_at
        pipeline.finished_at = metrics.finished_at if metrics else pipeline.finished_at
        pipeline.duration_seconds = metrics.total_duration_seconds if metrics else 0.0
        pipeline.total_tokens_in = metrics.total_tokens_in if metrics else 0
        pipeline.total_tokens_out = metrics.total_tokens_out if metrics else 0
        pipeline.total_llm_calls = metrics.total_llm_calls if metrics else 0
        pipeline.total_tool_calls = metrics.total_tool_calls if metrics else 0
        pipeline.total_messages = metrics.total_messages if metrics else 0
        pipeline.estimated_input_cost_usd = metrics.estimated_input_cost_usd if metrics else 0.0
        pipeline.estimated_output_cost_usd = metrics.estimated_output_cost_usd if metrics else 0.0
        pipeline.estimated_total_cost_usd = metrics.estimated_total_cost_usd if metrics else 0.0
        return pipeline

    def _upsert_run_snapshot(self, pipeline: PipelineRunRecord, result: PipelineResult) -> None:
        snapshot = self._session.query(RunSnapshotRecord).filter_by(run_id=result.run_id).first()
        if snapshot is None:
            snapshot = RunSnapshotRecord(run_id=result.run_id, pipeline_run_id=pipeline.id)
            self._session.add(snapshot)
            self._session.flush()
        snapshot.pipeline_run_id = pipeline.id
        snapshot.snapshot_json = result.model_dump(mode="json")

    def _replace_normalized_children(self, pipeline_run_id: int) -> None:
        agent_run_ids = self._session.query(AgentRunRecord.id).filter(AgentRunRecord.pipeline_run_id == pipeline_run_id)
        self._session.query(MemoryHintUsedRecord).filter(MemoryHintUsedRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(PromptCompilationRecord).filter(PromptCompilationRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(LLMCallRecord).filter(LLMCallRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(ToolCallRecord).filter(ToolCallRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(AgentOutputRecord).filter(AgentOutputRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(RuntimeEventRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunModelUsageRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunStreamRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunScreenshotRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(ProviderAnalysisRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(TakedownEmailRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(AgentRunRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)

    def _persist_agent_runs(self, pipeline_run_id: int, result: PipelineResult, trace: RunTrace | None) -> list[dict[str, Any]]:
        contexts = _extract_agent_contexts(trace, result)
        rows: list[dict[str, Any]] = []
        for ctx in contexts:
            agent_run = AgentRunRecord(
                pipeline_run_id=pipeline_run_id,
                actor=ctx["actor"],
                agent_type=ctx["agent_type"],
                target_url=ctx["target_url"],
                page_type=ctx["page_type"],
                status=ctx["status"],
                tool_call_budget=ctx["tool_call_budget"],
                tool_calls_made=ctx["tool_calls_made"],
                llm_calls_made=ctx["llm_calls_made"],
                prompt_compiled=bool(ctx.get("prompt")),
                memory_injected=bool(ctx.get("memory_loaded")),
                started_at=ctx["started_at"],
                finished_at=ctx["finished_at"],
                duration_seconds=ctx["duration_seconds"],
                invocation_index=ctx["invocation_index"],
            )
            self._session.add(agent_run)
            self._session.flush()

            output_payload = _agent_output_payload(ctx, result)
            self._session.add(
                AgentOutputRecord(
                    agent_run_id=agent_run.id,
                    output_json=output_payload,
                    summary_text=_agent_output_summary(ctx["agent_type"], output_payload),
                    stream_count=_stream_count_from_payload(output_payload),
                    embedded_url_count=len(output_payload.get("embedded_urls", []) or []),
                    hosting_page_count=len(output_payload.get("hosting_pages", []) or []),
                    validation_status="ok" if output_payload else "missing",
                )
            )

            prompt_details = ctx.get("prompt") or {}
            if prompt_details:
                prompt_version_id = self._ensure_prompt_version(ctx["agent_type"], prompt_details)
                self._session.add(
                    PromptCompilationRecord(
                        prompt_version_id=prompt_version_id,
                        agent_run_id=agent_run.id,
                        cache_mode=str(prompt_details.get("cache_mode", "") or ""),
                        compiled_prompt_hash=str(prompt_details.get("compiled_prompt_hash", "") or ""),
                        provider_cache_key=str(prompt_details.get("provider_cache_key", "") or ""),
                        provider_cache_eligible=bool(prompt_details.get("provider_cache_eligible", False)),
                        static_cache_hit=bool(prompt_details.get("static_cache_hit", False)),
                        memory_injected=bool(prompt_details.get("memory_injected", False)),
                        output_contract_version=str(prompt_details.get("output_contract_version", "") or ""),
                        sections_json=prompt_details.get("sections", []) or [],
                        metadata_json=prompt_details,
                    )
                )

            self._persist_llm_calls(agent_run.id, ctx)
            self._persist_tool_calls(agent_run.id, ctx)
            rows.append({**ctx, "id": agent_run.id})
        return rows

    def _persist_llm_calls(self, agent_run_id: int, ctx: dict[str, Any]) -> None:
        llm_seq = 0
        for event in ctx["events"]:
            if event.kind != "llm_response":
                continue
            llm_seq += 1
            details = event.details or {}
            prompt_details = details.get("prompt", {}) or ctx.get("prompt", {}) or {}
            self._session.add(
                LLMCallRecord(
                    agent_run_id=agent_run_id,
                    seq=llm_seq,
                    provider=str(details.get("provider", "") or ""),
                    model_name=str(details.get("model_name", "") or ""),
                    prompt_version=str(prompt_details.get("prompt_version", "") or ""),
                    prompt_hash=str(prompt_details.get("prompt_hash", "") or ""),
                    cache_mode=str(prompt_details.get("cache_mode", "") or ""),
                    input_tokens=int(details.get("input_tokens", 0) or 0),
                    output_tokens=int(details.get("output_tokens", 0) or 0),
                    estimated_input_cost_usd=0.0,
                    estimated_output_cost_usd=0.0,
                    estimated_total_cost_usd=0.0,
                    tool_calls_requested=int(details.get("tool_calls", 0) or 0),
                    tools_requested=details.get("tool_call_names", []) or [],
                    content_preview=str(details.get("content_preview", "") or ""),
                    usage_metadata_json=details.get("usage_metadata", {}) or {},
                    response_metadata_json=details.get("response_metadata", {}) or {},
                    created_at=event.timestamp,
                )
            )

    def _persist_tool_calls(self, agent_run_id: int, ctx: dict[str, Any]) -> None:
        pending: dict[int, dict[str, Any]] = {}
        seq = 0
        for event in ctx["events"]:
            details = event.details or {}
            if event.kind == "tool_call_started":
                seq += 1
                pending[seq] = {
                    "tool_name": str(details.get("tool_name", "") or ""),
                    "args": details.get("tool_args", {}) or {},
                    "started_at": event.timestamp,
                }
            elif event.kind == "tool_call_finished":
                current_seq = max(pending.keys(), default=0)
                started = pending.pop(current_seq, None)
                tool_name = str(details.get("tool_name", "") or (started or {}).get("tool_name", ""))
                result_preview = str(details.get("result_preview", "") or "")
                status = str(details.get("status", "") or event.status or "info")
                error_text = result_preview if status == "error" else ""
                self._session.add(
                    ToolCallRecord(
                        agent_run_id=agent_run_id,
                        seq=current_seq or seq or 1,
                        tool_name=tool_name,
                        args_json=(started or {}).get("args", {}),
                        target_summary=_tool_target_summary(tool_name, (started or {}).get("args", {})),
                        status=status,
                        duration_seconds=float(details.get("duration_seconds", 0.0) or 0.0),
                        result_preview=result_preview,
                        error_text=error_text,
                        started_at=(started or {}).get("started_at", event.timestamp),
                        finished_at=event.timestamp,
                    )
                )

    def _persist_runtime_events(self, pipeline_run_id: int, trace: RunTrace | None, agent_runs: list[dict[str, Any]]) -> None:
        if trace is None:
            return
        seq_to_agent_run_id: dict[int, int | None] = {}
        for agent_run in agent_runs:
            for event in agent_run["events"]:
                seq_to_agent_run_id[event.seq] = agent_run["id"]
        for event in trace.events:
            self._session.add(
                RuntimeEventRecord(
                    pipeline_run_id=pipeline_run_id,
                    agent_run_id=seq_to_agent_run_id.get(event.seq),
                    actor=event.actor,
                    seq=event.seq,
                    kind=event.kind,
                    status=event.status,
                    message=event.message,
                    details_json=event.details or {},
                    created_at=event.timestamp,
                )
            )

    def _persist_run_model_usage(self, pipeline_run_id: int, result: PipelineResult) -> None:
        metrics = result.metrics
        if metrics is None:
            return
        for entry in metrics.model_usage:
            self._session.add(
                RunModelUsageRecord(
                    pipeline_run_id=pipeline_run_id,
                    provider=entry.provider,
                    model_name=entry.model_name,
                    llm_calls=entry.llm_calls,
                    input_tokens=entry.input_tokens,
                    output_tokens=entry.output_tokens,
                    estimated_input_cost_usd=entry.estimated_input_cost_usd,
                    estimated_output_cost_usd=entry.estimated_output_cost_usd,
                    estimated_total_cost_usd=entry.estimated_total_cost_usd,
                )
            )

    def _persist_run_streams(self, pipeline_run_id: int, result: PipelineResult) -> None:
        for stream in result.all_streams:
            self._session.add(
                RunStreamRecord(
                    pipeline_run_id=pipeline_run_id,
                    stream_url=stream.url,
                    source_url=result.url,
                    protocol=stream.protocol or "",
                    quality=stream.quality or "",
                    source_layer=stream.source_layer or "",
                    server_label=stream.source_layer or "",
                    dedupe_hash=_hash_text(stream.url),
                    captured_at=stream.captured_at,
                )
            )

    def _persist_run_screenshots(self, pipeline_run_id: int, result: PipelineResult) -> None:
        for screenshot in result.all_screenshots:
            self._session.add(
                RunScreenshotRecord(
                    pipeline_run_id=pipeline_run_id,
                    screenshot_url=screenshot,
                    source_url=result.url,
                )
            )

    def _persist_provider_analyses(self, pipeline_run_id: int, result: PipelineResult) -> None:
        for provider in result.provider_analysis:
            self._session.add(
                ProviderAnalysisRecord(
                    pipeline_run_id=pipeline_run_id,
                    stream_url=provider.stream_url,
                    ip=provider.ip,
                    hostname=provider.hostname,
                    org=provider.org,
                    provider=provider.provider,
                    country=provider.country,
                    region=provider.region,
                    city=provider.city,
                    abuse_email=provider.abuse_email,
                    whois_raw=provider.whois_raw,
                )
            )

    def _persist_takedown_emails(self, pipeline_run_id: int, result: PipelineResult) -> None:
        for email in result.takedown_emails:
            self._session.add(
                TakedownEmailRecord(
                    pipeline_run_id=pipeline_run_id,
                    provider=email.provider,
                    abuse_email=email.abuse_email,
                    subject=email.subject,
                    body=email.body,
                    infringing_url=email.infringing_url,
                    stream_urls_json=list(email.stream_urls),
                    screenshot_urls_json=list(email.screenshot_urls),
                    server_labels_json=list(email.server_labels),
                    provider_info_json=email.provider_info.model_dump(mode="json") if email.provider_info else {},
                    generated_at=email.generated_at,
                )
            )

    def _persist_memory_entries(
        self,
        run_id: str,
        pipeline_run_id: int,
        agent_runs: list[dict[str, Any]],
        result: PipelineResult,
        trace: RunTrace | None,
    ) -> None:
        for agent_run in agent_runs:
            if agent_run["agent_type"] == AgentType.ORCHESTRATOR.value:
                continue
            if agent_run["status"] not in {"success", "partial"}:
                continue
            payload = _agent_output_payload(agent_run, result)
            if not payload:
                continue
            entry = build_site_memory_entry(
                url=agent_run["target_url"] or result.url,
                page_type=agent_run["agent_type"],
                status=agent_run["status"],
                payload=payload,
                trace=trace,
                actor=agent_run["actor"],
                short_memory_summary="",
            )
            self._session.add(
                MemoryEntryRecord(
                    domain=entry["domain"],
                    page_type=entry["page_type"],
                    source_run_id=run_id,
                    source_agent_run_id=agent_run["id"],
                    status=entry["status"],
                    success=entry["success"],
                    url=entry["url"],
                    data_json=entry,
                    result_summary=entry.get("result_summary", ""),
                )
            )

    def _persist_memory_hints_used(self, run_id: str, agent_runs: list[dict[str, Any]]) -> None:
        for agent_run in agent_runs:
            memory_load = agent_run.get("memory_loaded") or {}
            url = str(memory_load.get("url", "") or "").strip()
            page_type = str(memory_load.get("page_type", "") or "").strip()
            if not url or not page_type:
                continue
            domain = _normalize_domain(url)
            rows = (
                self._session.query(MemoryEntryRecord)
                .filter(
                    MemoryEntryRecord.domain == domain,
                    MemoryEntryRecord.page_type == page_type,
                    MemoryEntryRecord.source_run_id != run_id,
                )
                .order_by(MemoryEntryRecord.created_at.desc())
                .limit(5)
                .all()
            )
            for row in rows:
                self._session.add(
                    MemoryHintUsedRecord(
                        agent_run_id=agent_run["id"],
                        memory_entry_id=row.id,
                    )
                )

    def _ensure_prompt_version(self, agent_type: str, prompt_details: dict[str, Any]) -> int | None:
        prompt_path = _PROMPT_PATHS.get(agent_type)
        if prompt_path is None or not prompt_path.exists():
            return None
        prompt_text = prompt_path.read_text(encoding="utf-8")
        prompt_hash = str(prompt_details.get("prompt_hash", "") or _hash_text(prompt_text))
        record = (
            self._session.query(PromptVersionRecord)
            .filter_by(agent_id=agent_type, content_hash=prompt_hash)
            .first()
        )
        if record is None:
            record = PromptVersionRecord(
                agent_id=agent_type,
                source_path=str(prompt_path),
                semantic_version=prompt_path.stem,
                content_hash=prompt_hash,
                prompt_text=prompt_text,
                active=True,
            )
            self._session.add(record)
            self._session.flush()
        return record.id


def _extract_agent_contexts(trace: RunTrace | None, result: PipelineResult) -> list[dict[str, Any]]:
    if trace is None:
        return _fallback_agent_contexts(result)

    contexts: list[dict[str, Any]] = []
    open_runs: dict[str, dict[str, Any]] = {}
    invocation_counts: dict[str, int] = {}

    for event in trace.events:
        actor = event.actor or "unknown"
        kind = event.kind
        is_start = kind in {"agent_started", "pipeline_started"}
        is_finish = kind in {"agent_finished", "pipeline_finished", "pipeline_failed"}
        current = open_runs.get(actor)

        if is_start:
            invocation_counts[actor] = invocation_counts.get(actor, 0) + 1
            current = {
                "actor": actor,
                "agent_type": _ACTOR_TO_AGENT_TYPE.get(actor, actor),
                "events": [event],
                "started_at": event.timestamp,
                "finished_at": None,
                "invocation_index": invocation_counts[actor],
            }
            open_runs[actor] = current
            continue

        if current is None:
            invocation_counts[actor] = invocation_counts.get(actor, 0) + 1
            current = {
                "actor": actor,
                "agent_type": _ACTOR_TO_AGENT_TYPE.get(actor, actor),
                "events": [],
                "started_at": event.timestamp,
                "finished_at": None,
                "invocation_index": invocation_counts[actor],
            }
            open_runs[actor] = current

        current["events"].append(event)

        if is_finish:
            current["finished_at"] = event.timestamp
            contexts.append(current)
            open_runs.pop(actor, None)

    for current in open_runs.values():
        current["finished_at"] = current["events"][-1].timestamp if current["events"] else current["started_at"]
        contexts.append(current)

    contexts.sort(key=lambda item: item["started_at"])

    type_counts: dict[str, int] = {}
    default_page_type = result.classification.page_type.value if result.classification else "unknown"
    for ctx in contexts:
        agent_type = ctx["agent_type"]
        type_counts[agent_type] = type_counts.get(agent_type, 0) + 1
        ctx["type_invocation_index"] = type_counts[agent_type]
        ctx["target_url"] = _extract_target_url(ctx["events"], result.url)
        ctx["page_type"] = _page_type_for_agent(agent_type, default_page_type)
        ctx["prompt"] = _first_event_details(ctx["events"], "prompt_compiled")
        ctx["memory_loaded"] = _first_event_details(ctx["events"], "memory_loaded")
        ctx["tool_call_budget"] = int((_first_event_details(ctx["events"], "agent_loop_started") or {}).get("max_tool_calls", 0) or 0)
        ctx["tool_calls_made"] = sum(1 for event in ctx["events"] if event.kind == "tool_call_started")
        ctx["llm_calls_made"] = sum(1 for event in ctx["events"] if event.kind == "llm_response")
        ctx["duration_seconds"] = max((ctx["finished_at"] - ctx["started_at"]).total_seconds(), 0.0)
        ctx["status"] = _resolve_agent_status(ctx, result)
    return contexts


def _fallback_agent_contexts(result: PipelineResult) -> list[dict[str, Any]]:
    started_at = result.metrics.started_at if result.metrics else datetime.utcnow()
    finished_at = result.metrics.finished_at if result.metrics and result.metrics.finished_at else started_at
    contexts: list[dict[str, Any]] = [
        {
            "actor": "orchestrator",
            "agent_type": AgentType.ORCHESTRATOR.value,
            "events": [],
            "started_at": started_at,
            "finished_at": finished_at,
            "invocation_index": 1,
            "type_invocation_index": 1,
            "target_url": result.url,
            "page_type": result.classification.page_type.value if result.classification else "unknown",
            "prompt": {},
            "memory_loaded": {},
            "tool_call_budget": 0,
            "tool_calls_made": 0,
            "llm_calls_made": 0,
            "duration_seconds": result.metrics.total_duration_seconds if result.metrics else 0.0,
            "status": result.final_status.value,
        }
    ]
    if result.classification:
        contexts.append(
            {
                "actor": "classification",
                "agent_type": AgentType.CLASSIFICATION.value,
                "events": [],
                "started_at": started_at,
                "finished_at": finished_at,
                "invocation_index": 1,
                "type_invocation_index": 1,
                "target_url": result.url,
                "page_type": AgentType.CLASSIFICATION.value,
                "prompt": {},
                "memory_loaded": {},
                "tool_call_budget": 0,
                "tool_calls_made": 0,
                "llm_calls_made": 0,
                "duration_seconds": 0.0,
                "status": "success",
            }
        )
    return contexts


def _agent_output_payload(ctx: dict[str, Any], result: PipelineResult) -> dict[str, Any]:
    agent_type = ctx["agent_type"]
    target_url = ctx.get("target_url") or result.url
    occurrence = ctx.get("type_invocation_index", 1)

    if agent_type == AgentType.ORCHESTRATOR.value:
        return {
            "run_id": result.run_id,
            "url": result.url,
            "final_status": result.final_status.value,
            "stream_count": len(result.all_streams),
            "email_count": len(result.takedown_emails),
        }
    if agent_type == AgentType.CLASSIFICATION.value and result.classification is not None:
        return result.classification.model_dump(mode="json")
    if agent_type == AgentType.LANDING_PAGE.value:
        return {"hosting_pages": [match.model_dump(mode="json") for match in result.matches]}

    candidates = [
        extraction
        for extraction in result.extraction_results
        if extraction.agent_type.value == agent_type
    ]
    exact = [candidate for candidate in candidates if candidate.url == target_url]
    if exact:
        chosen = exact[0]
    elif len(candidates) >= occurrence:
        chosen = candidates[occurrence - 1]
    else:
        chosen = None
    return chosen.model_dump(mode="json") if chosen is not None else {}


def _agent_output_summary(agent_type: str, payload: dict[str, Any]) -> str:
    if not payload:
        return ""
    if agent_type == AgentType.CLASSIFICATION.value:
        return f"classified as {payload.get('page_type', 'unknown')}"
    if agent_type == AgentType.LANDING_PAGE.value:
        return f"hosting pages found={len(payload.get('hosting_pages', []) or [])}"
    if agent_type in {AgentType.HOSTING_PAGE.value, AgentType.EMBEDDED_PAGE.value}:
        return f"streams found={_stream_count_from_payload(payload)}"
    if agent_type == AgentType.ORCHESTRATOR.value:
        return f"pipeline status={payload.get('final_status', 'unknown')}"
    return ""


def _stream_count_from_payload(payload: dict[str, Any]) -> int:
    count = len(payload.get("streams", []) or [])
    count += len(payload.get("streaming_urls", []) or [])
    count += len(payload.get("all_stream_urls", []) or [])
    for server in payload.get("servers", []) or []:
        count += len(server.get("m3u8_urls", []) or [])
        count += len(server.get("mpd_urls", []) or [])
        count += len(server.get("mp4_urls", []) or [])
    return count


def _resolve_agent_status(ctx: dict[str, Any], result: PipelineResult) -> str:
    agent_type = ctx["agent_type"]
    payload = _agent_output_payload(ctx, result)
    if agent_type == AgentType.ORCHESTRATOR.value:
        return result.final_status.value
    if agent_type == AgentType.CLASSIFICATION.value:
        return "success" if result.classification is not None else "failed"
    if agent_type == AgentType.LANDING_PAGE.value:
        return "success" if payload.get("hosting_pages") else "failed"
    if agent_type in {AgentType.HOSTING_PAGE.value, AgentType.EMBEDDED_PAGE.value}:
        status = str(payload.get("status", "") or "")
        return status or str(ctx["events"][-1].status or "unknown").replace("warning", "partial")
    return str(ctx["events"][-1].status or "unknown")


def _first_event_details(events: list[Any], kind: str) -> dict[str, Any]:
    for event in events:
        if event.kind == kind:
            return event.details or {}
    return {}


def _extract_target_url(events: list[Any], default_url: str) -> str:
    for event in events:
        details = event.details or {}
        for key in ("url", "mainUrl", "player_iframe_url", "base_url"):
            if details.get(key):
                return str(details[key])
        match = re.search(r"for (https?://\S+)", event.message or "")
        if match:
            return match.group(1).rstrip(".")
    return default_url


def _page_type_for_agent(agent_type: str, default_page_type: str) -> str:
    if agent_type == AgentType.CLASSIFICATION.value:
        return AgentType.CLASSIFICATION.value
    if agent_type == AgentType.ORCHESTRATOR.value:
        return default_page_type
    return agent_type


def _tool_target_summary(tool_name: str, tool_args: dict[str, Any] | None) -> str:
    args = tool_args or {}
    for key in ("url", "mainUrl", "player_iframe_url", "selector", "text", "xpath", "kind", "action", "value"):
        value = args.get(key)
        if value not in (None, "", [], {}):
            return f"{tool_name} on {key}={value}"
    return tool_name


def _normalize_domain(url: str) -> str:
    host = (urlparse(url).netloc or "").lower().strip()
    return host[4:] if host.startswith("www.") else host


def _hash_text(value: str) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()
