from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from src.models.enums import Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, PipelineResult, RunMetrics, StreamURL
from src.storage.database import Base
from src.storage.repositories import RunRepository


def test_run_repository_saves_pipeline_metrics_and_stream_count():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)

    session = Session(engine)
    repo = RunRepository(session)
    result = PipelineResult(
        run_id="run-1",
        url="https://example.com/watch",
        classification=ClassificationResult(
            url="https://example.com/watch",
            page_type=PageType.HOSTING,
            confidence=Confidence.HIGH,
            reasoning="Has a player.",
        ),
        final_status=ExtractionStatus.SUCCESS,
        all_streams=[StreamURL(url="https://cdn.example.com/master.m3u8", protocol="hls")],
        metrics=RunMetrics(
            run_id="run-1",
            url="https://example.com/watch",
            total_tokens_in=11,
            total_tokens_out=7,
            total_tool_calls=3,
            total_duration_seconds=9.5,
            success=True,
        ),
    )

    record = repo.save(result)

    assert record.page_type == "hosting_page"
    assert record.status == "success"
    assert record.streams_found == 1
    assert record.tokens_in == 11
    assert record.tokens_out == 7
    assert record.tool_calls == 3
