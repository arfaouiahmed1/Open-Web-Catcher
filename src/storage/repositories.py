"""CRUD operations for runs, results, and metrics."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from src.models.schemas import PipelineResult
from src.storage.database import RunRecord


class RunRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def save(self, result: PipelineResult) -> RunRecord:
        record = RunRecord(
            run_id=result.run_id,
            url=result.url,
            page_type=result.classification.page_type if result.classification else "unknown",
            status=result.final_status,
            streams_found=len(result.streams),
            success=result.final_status == "success",
            result_json=result.model_dump(),
        )
        if result.metrics:
            record.tokens_in = result.metrics.total_tokens_in
            record.tokens_out = result.metrics.total_tokens_out
            record.tool_calls = result.metrics.total_tool_calls
            record.duration_seconds = result.metrics.total_duration_seconds
            record.failure_mode = result.metrics.failure_mode

        self._session.add(record)
        self._session.commit()
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
        total = self._session.query(RunRecord).count()
        if total == 0:
            return 0.0
        successes = self._session.query(RunRecord).filter_by(success=True).count()
        return successes / total
