from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


def _config(db_path: Path) -> Config:
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return config


def test_alembic_upgrade_creates_normalized_tables(tmp_path):
    db_path = tmp_path / "migration.db"

    command.upgrade(_config(db_path), "head")

    inspector = inspect(create_engine(f"sqlite:///{db_path}"))
    table_names = set(inspector.get_table_names())

    assert "runs" in table_names
    assert "pipeline_runs" in table_names
    assert "agent_runs" in table_names
    assert "llm_calls" in table_names
    assert "tool_calls" in table_names
    assert "memory_entries" in table_names
    assert "prompt_compilations" in table_names


def test_alembic_upgrade_preserves_existing_legacy_rows(tmp_path):
    db_path = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{db_path}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE runs (id INTEGER PRIMARY KEY, run_id VARCHAR(64), url TEXT, page_type VARCHAR(32), status VARCHAR(32), streams_found INTEGER, tokens_in INTEGER, tokens_out INTEGER, tool_calls INTEGER, duration_seconds FLOAT, success BOOLEAN, failure_mode VARCHAR(64), result_json JSON, created_at DATETIME)"))
        conn.execute(text("INSERT INTO runs (run_id, url, page_type, status, streams_found, tokens_in, tokens_out, tool_calls, duration_seconds, success, failure_mode, result_json, created_at) VALUES ('run-1', 'https://example.com', 'hosting_page', 'success', 1, 0, 0, 0, 1.0, 1, '', '{}', CURRENT_TIMESTAMP)"))

    command.upgrade(_config(db_path), "head")

    with engine.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM runs")).scalar_one()

    assert count == 1
