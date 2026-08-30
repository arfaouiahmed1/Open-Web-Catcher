"""Plan task 32 — retention extension + payload caps + blob overflow store.

Covers:

- ``cleanup_old_artifacts`` now deletes across ALL artifact families
  (run_snapshots, llm_calls, tool_calls, agent_outputs, legacy runs) in
  addition to the already-covered runtime_events / run_screenshots.
- Rows inside the retention window survive untouched.
- Per-table windows are configurable via ``days_by_table``.
- Oversized inline payloads (``result_full`` / ``content_full``) overflow to
  ``data/blobs/`` and persist as a ``blobref:<hash>`` pointer; under-cap
  values pass through unchanged.
- Inline base64 screenshot data URIs land as blob refs instead of megabytes
  of base64 text in ``run_screenshots.screenshot_url``.

Blob files are redirected via the ``BLOB_STORE_DIR`` env var so tests never
touch the repo's real ``data/blobs`` directory.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.storage.models import (
    AgentOutputRecord,
    AgentRunRecord,
    Base,
    LLMCallRecord,
    PipelineRunRecord,
    RunRecord,
    RunScreenshotRecord,
    RunSnapshotRecord,
    RuntimeEventRecord,
    ToolCallRecord,
)
from src.storage.repositories import RunRepository, _cap_payload_fields
from src.utils.observability import RuntimeEvent


@pytest.fixture()
def blobs_dir(tmp_path, monkeypatch):
    target = tmp_path / "blobs"
    monkeypatch.setenv("BLOB_STORE_DIR", str(target))
    return target


@pytest.fixture()
def session(blobs_dir):
    engine = create_engine(f"sqlite:///{blobs_dir.parent / 'db.sqlite3'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    sess = factory()
    yield sess
    sess.close()
    engine.dispose()


def _seed_pipeline(sess, run_id: str, *, age_days: float):
    """Seed one row into every retention-covered table for a pipeline."""
    stamp = datetime.now(UTC) - timedelta(days=age_days)
    pipeline = PipelineRunRecord(
        run_id=run_id,
        root_url="https://example.test",
        final_status="success",
        success=True,
        started_at=stamp,
        finished_at=stamp,
    )
    sess.add(pipeline)
    sess.flush()

    sess.add(
        RunSnapshotRecord(
            pipeline_run_id=pipeline.id,
            run_id=run_id,
            snapshot_json={"run_id": run_id},
            created_at=stamp,
        )
    )
    agent_run = AgentRunRecord(
        pipeline_run_id=pipeline.id,
        actor="landing",
        agent_type="landing_page",
        status="success",
        started_at=stamp,
    )
    sess.add(agent_run)
    sess.flush()
    sess.add(LLMCallRecord(agent_run_id=agent_run.id, seq=1, created_at=stamp))
    sess.add(
        ToolCallRecord(agent_run_id=agent_run.id, seq=1, tool_name="navigate", started_at=stamp)
    )
    sess.add(AgentOutputRecord(agent_run_id=agent_run.id, output_json={}, created_at=stamp))
    sess.add(
        RuntimeEventRecord(
            pipeline_run_id=pipeline.id,
            actor="landing",
            seq=1,
            kind="llm_response",
            message="m",
            details_json={},
            created_at=stamp,
        )
    )
    sess.add(
        RunScreenshotRecord(
            pipeline_run_id=pipeline.id,
            screenshot_url="https://cdn.example.test/shot.png",
            source_url="https://example.test",
            created_at=stamp,
        )
    )
    sess.add(
        RunRecord(
            run_id=run_id,
            url="https://example.test",
            result_json={},
            created_at=stamp,
        )
    )
    sess.commit()


def test_retention_deletes_old_rows_across_all_tables(session):
    _seed_pipeline(session, "old-run", age_days=40)
    _seed_pipeline(session, "new-run", age_days=1)

    counts = RunRepository(session).cleanup_old_artifacts(retention_days=30)

    assert counts["runtime_events_deleted"] == 1
    assert counts["run_screenshots_deleted"] == 1
    assert counts["run_snapshots_deleted"] == 1
    assert counts["llm_calls_deleted"] == 1
    assert counts["tool_calls_deleted"] == 1
    assert counts["agent_outputs_deleted"] == 1
    assert counts["runs_deleted"] == 1

    # Fresh rows survive everywhere.
    assert session.query(PipelineRunRecord).filter_by(run_id="new-run").count() == 1
    assert session.query(RunSnapshotRecord).count() == 1
    # NOTE: agent_runs rows themselves are NOT in the retention scope
    # (task 32 covers run_snapshots/llm_calls/tool_calls/agent_outputs/
    # legacy runs + the previously covered runtime_events/run_screenshots),
    # so both seeded agent_run rows survive while their children are purged.
    assert session.query(AgentRunRecord).count() == 2
    assert session.query(LLMCallRecord).count() == 1
    assert session.query(ToolCallRecord).count() == 1
    assert session.query(AgentOutputRecord).count() == 1
    assert session.query(RuntimeEventRecord).count() == 1
    assert session.query(RunScreenshotRecord).count() == 1
    assert session.query(RunRecord).count() == 1


def test_retention_days_by_table_override(session):
    # 20-day-old llm rows must go with a tighter per-table window while the
    # default 30-day window keeps everything else (including snapshots).
    _seed_pipeline(session, "mid-run", age_days=20)

    counts = RunRepository(session).cleanup_old_artifacts(
        retention_days=30,
        days_by_table={"llm_calls": 10},
    )

    assert counts["llm_calls_deleted"] == 1
    assert counts["run_snapshots_deleted"] == 0
    assert counts["agent_outputs_deleted"] == 0
    assert counts["runs_deleted"] == 0
    assert session.query(LLMCallRecord).count() == 0
    assert session.query(RunSnapshotRecord).count() == 1


def test_oversized_payload_becomes_blobref_and_file_exists(blobs_dir):
    from src.storage.blob_store import cap_or_overflow, read_blob

    big = "x" * 9000  # > default-ish cap passed explicitly below
    ref = cap_or_overflow(big, cap_bytes=8192)

    assert ref.startswith("blobref:")
    assert read_blob(ref) == b"x" * 9000
    assert blobs_dir.exists()
    assert len(list(blobs_dir.iterdir())) == 1


def test_under_cap_payload_passes_through_unchanged(blobs_dir):
    from src.storage.blob_store import cap_or_overflow

    small = "compact result"
    assert cap_or_overflow(small, cap_bytes=8192) == small
    assert not blobs_dir.exists() or not any(blobs_dir.iterdir())


def test_cap_payload_fields_caps_nested_result_full(session, blobs_dir):
    payload = {
        "result_full": "z" * 10000,
        "nested": {"content_full": "w" * 10000, "result_preview": "tiny"},
        "items": [{"content_full": "q" * 10000}],
    }
    capped = _cap_payload_fields(payload, cap_bytes=8192)

    assert capped["result_full"].startswith("blobref:")
    assert capped["nested"]["content_full"].startswith("blobref:")
    assert capped["nested"]["result_preview"] == "tiny"
    assert capped["items"][0]["content_full"].startswith("blobref:")


def test_persist_llm_call_content_full_overflows_to_blob(session, blobs_dir):
    _seed_pipeline(session, "cap-run", age_days=0.001)
    agent_run = (
        session.query(AgentRunRecord)
        .join(PipelineRunRecord)
        .filter_by(run_id="cap-run")
        .one()
    )

    event = RuntimeEvent(
        seq=1,
        actor="landing",
        kind="llm_response",
        message="resp",
        details={
            "provider": "openai",
            "model_name": "gpt-test",
            "content_preview": "preview",
            "content_full": "y" * 20000,
            "input_tokens": 10,
            "output_tokens": 5,
        },
    )
    RunRepository(session)._persist_llm_calls(agent_run.id, {"events": [event], "prompt": {}})
    session.commit()

    row = (
        session.query(LLMCallRecord).order_by(LLMCallRecord.id.desc()).first()
    )  # seed helper also wrote one; the newest row is the capped one
    stored = row.response_metadata_json.get("content_full", "")
    assert stored.startswith("blobref:")
    from src.storage.blob_store import read_blob

    assert read_blob(stored) == b"y" * 20000


def test_inline_base64_screenshot_persists_as_file_ref(session, blobs_dir):
    _seed_pipeline(session, "shot-run", age_days=0.001)
    pipeline = session.query(PipelineRunRecord).filter_by(run_id="shot-run").one()

    png_bytes = b"\x89PNG-fake-image-bytes"
    data_uri = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
    RunRepository(session)._persist_trace_screenshots(
        pipeline.id, [data_uri], source_url="https://example.test"
    )
    session.commit()

    row = session.query(RunScreenshotRecord).filter(RunScreenshotRecord.screenshot_url != "https://cdn.example.test/shot.png").one()
    assert row.screenshot_url.startswith("blobref:")
    from src.storage.blob_store import read_blob

    assert read_blob(row.screenshot_url) == png_bytes


def test_attributed_plus_fallback_screenshot_not_double_persisted(session, blobs_dir):
    """Review fix #1 (major): dedupe must compare raw AND converted forms.

    A screenshot appearing both as an attributed row and in the plain
    fallback list must yield exactly ONE persisted row, not a blobref row
    plus an inline-base64 duplicate.
    """
    from src.storage.blob_store import read_blob

    _seed_pipeline(session, "dedupe-run", age_days=0.001)
    pipeline = session.query(PipelineRunRecord).filter_by(run_id="dedupe-run").one()
    repo = RunRepository(session)

    png_bytes = b"\x89PNG-dedupe-probe"
    data_uri = "data:image/png;base64," + base64.b64encode(png_bytes).decode()

    from datetime import datetime as _dt

    from src.utils.observability import ObservabilityStatus, RunTrace, RuntimeEvent

    obs = ObservabilityStatus(
        enabled=False, provider="internal", project="t", default_dataset_name="t"
    )

    class _FakeResult:
        url = "https://example.test/dedupe"
        all_screenshots = [data_uri]

    trace = RunTrace(
        run_id="dedupe-run",
        root_actor="test",
        started_at=_dt.utcnow(),
        observability=obs,
        events=[
            RuntimeEvent(
                seq=1,
                actor="test",
                kind="tool_call_ended",
                message="shot",
                details={"screenshot_url": data_uri, "tool_name": "inspect_hosting"},
            ),
        ],
    )
    repo._persist_run_screenshots(
        pipeline.id, _FakeResult(), trace=trace, agent_runs=[]
    )
    session.commit()

    rows = (
        session.query(RunScreenshotRecord)
        .filter(RunScreenshotRecord.pipeline_run_id == pipeline.id)
        .all()
    )
    # One seeded CDN row from _seed_pipeline + ONE blobref from the
    # attributed/fallback pair. The failure mode under review was the same
    # URI persisting twice (blobref row + inline-base64 fallback row).
    blobref_rows = [r for r in rows if r.screenshot_url.startswith("blobref:")]
    assert len(blobref_rows) == 1, f"expected 1 blobref row, got {len(blobref_rows)}"
    assert all(r.screenshot_url != data_uri for r in rows), "raw base64 must not be persisted"
    assert read_blob(blobref_rows[0].screenshot_url) == png_bytes


def test_blob_gc_deletes_only_unreferenced_files(session, blobs_dir):
    """Review fix #4: cleanup GCs blob files with no surviving DB reference."""
    from src.storage.blob_store import read_blob, write_blob

    _seed_pipeline(session, "gc-old", age_days=45)
    _seed_pipeline(session, "gc-new", age_days=0.001)
    old_pipeline = session.query(PipelineRunRecord).filter_by(run_id="gc-old").one()
    new_pipeline = session.query(PipelineRunRecord).filter_by(run_id="gc-new").one()

    doomed_ref = write_blob(b"doomed-blob-payload")
    survivor_png = b"\x89PNG-survivor"
    survivor_ref = write_blob(survivor_png)
    from src.storage.models import RunScreenshotRecord as _RSR

    session.add(_RSR(pipeline_run_id=new_pipeline.id, screenshot_url=survivor_ref, source_url="https://example.test"))
    session.commit()

    counts = RunRepository(session).cleanup_old_artifacts(retention_days=30)
    assert counts.get("blob_files_deleted", 0) >= 1
    assert read_blob(doomed_ref) is None, "unreferenced blob file should be gone"
    assert read_blob(survivor_ref) == survivor_png, "referenced blob must survive"
