from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.storage.dataset_repository import DatasetRepository
from src.storage.models import (
    AgentRunRecord,
    Base,
    PipelineRunRecord,
    RunModelUsageRecord,
)


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)()


def test_dataset_sites_can_be_created_updated_and_conflict_checked():
    session = _session()
    repo = DatasetRepository(session)

    first = repo.create_site(
        url="https://Example.com/watch/",
        language="english",
        label="piracy",
        notes="seed",
    )
    second = repo.create_site(
        url="https://example.com/watch",
        language="arabic",
        label="sports",
    )

    assert first["id"] == second["id"]
    assert repo.list_sites()["total"] == 1
    assert second["language"] == "arabic"

    other = repo.create_site(url="https://other.example/live", language="english")
    with pytest.raises(ValueError, match="already uses"):
        repo.update_site(other["id"], url="https://example.com/watch")

    updated = repo.update_site(first["id"], url="https://example.com/new", notes="updated")
    assert updated["canonical_url"] == "https://example.com/new"
    assert updated["notes"] == "updated"


def test_dataset_csv_seed_dedupes_pending_rows_with_autoflush_disabled(tmp_path):
    csv_path = tmp_path / "sites.csv"
    csv_path.write_text(
        "id,url,language,label,notes\n"
        "1,https://example.com/,english,piracy,first\n"
        "2,https://EXAMPLE.com,arabic,sports,second\n",
        encoding="utf-8",
    )
    session = _session()
    repo = DatasetRepository(session)

    result = repo.ensure_seeded_from_csv(csv_path)
    sites = repo.list_sites()

    assert result["inserted"] == 1
    assert result["updated"] == 1
    assert sites["total"] == 1
    assert sites["sites"][0]["language"] == "arabic"


def test_dataset_batches_dedupe_urls_and_enrich_run_context():
    session = _session()
    repo = DatasetRepository(session)
    repo.create_site(url="https://example.com/watch/", language="english", label="piracy")

    batch = repo.create_batch(
        urls=["https://example.com/watch/", "https://EXAMPLE.com/watch"],
        batch_name="smoke",
    )

    assert batch["requested_count"] == 1
    run_id = batch["runs"][0]["run_id"]

    pipeline = PipelineRunRecord(
        run_id=run_id,
        root_url="https://example.com/watch/",
        final_status="success",
        success=True,
        stream_count=2,
        screenshot_count=1,
        total_tokens_in=100,
        total_cached_input_tokens=30,
        total_new_input_tokens=70,
        total_tokens_out=40,
        total_llm_calls=2,
        total_tool_calls=3,
        estimated_total_cost_usd=0.123,
        duration_seconds=4.5,
        started_at=datetime.utcnow(),
        finished_at=datetime.utcnow(),
    )
    session.add(pipeline)
    session.flush()
    session.add(
        RunModelUsageRecord(
            pipeline_run_id=pipeline.id,
            provider="openai",
            model_name="gpt-4.1-mini",
            llm_calls=2,
            input_tokens=100,
            cached_input_tokens=30,
            new_input_tokens=70,
            output_tokens=40,
            estimated_total_cost_usd=0.123,
        )
    )
    session.add(
        AgentRunRecord(
            pipeline_run_id=pipeline.id,
            actor="hosting",
            agent_type="hosting_page",
            status="success",
            tool_calls_made=3,
            llm_calls_made=2,
            duration_seconds=4.5,
        )
    )
    session.commit()

    repo.finalize_site_run(
        run_id,
        display_status="success",
        result_json={"final_status": "success", "stream_count": 2},
    )

    detail = repo.get_site_detail(batch["runs"][0]["site_id"])
    assert detail["summary"]["terminal_runs"] == 1
    assert detail["summary"]["total_cost_usd"] == pytest.approx(0.123)
    assert detail["runs"][0]["total_tokens"] == 140
    assert detail["runs"][0]["model_usage"][0]["provider"] == "openai"
    assert detail["runs"][0]["agent_runs"][0]["agent_type"] == "hosting_page"

    context = repo.get_run_context(run_id)
    assert context is not None
    assert context["batch"]["batch_id"] == batch["batch_id"]
    assert context["site"]["url"] == "https://example.com/watch/"
