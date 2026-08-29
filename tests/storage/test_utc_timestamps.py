"""UTC end-to-end timestamp contract (plan T33).

Pins the three layers of the UTC guarantee:

1. Aware columns: ``DateTime(timezone=True)`` columns round-trip aware UTC
   datetimes through a real SQLite engine and REJECT/normalize naive reads —
   legacy naive strings are coerced back to aware-UTC on read.
2. ISO-Z serialization: ``iso_z`` emits Z-suffixed stamps and treats naive
   input AS UTC.
3. Writer defaults: model column defaults produce AWARE datetimes (no naive
   ``datetime.utcnow`` may survive in src/).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from src.storage.models import Base, RunRecord
from src.utils.timefmt import iso_z, to_utc


@pytest.fixture()
def session(tmp_path):
    engine = sa.create_engine(f"sqlite:///{tmp_path/'utc.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def test_all_datetime_columns_are_timezone_aware() -> None:
    naive = [
        f"{t.name}.{c.name}"
        for t in Base.metadata.tables.values()
        for c in t.columns
        if isinstance(c.type, sa.DateTime) and not c.type.timezone
    ]
    assert naive == [], f"naive DateTime columns remain: {naive}"


def test_model_default_is_aware_utc() -> None:
    value = RunRecord.__table__.columns["created_at"].default.arg(None)
    assert value.tzinfo is not None
    assert value.utcoffset() == timedelta(0)


def test_aware_round_trip_through_engine(session: Session) -> None:
    stamp = datetime(2026, 8, 26, 12, 30, 0, tzinfo=UTC)
    row = RunRecord(run_id="tz-1", url="https://example.com", created_at=stamp)
    session.add(row)
    session.commit()

    loaded = session.query(RunRecord).filter_by(run_id="tz-1").one()
    assert loaded.created_at.tzinfo is not None
    assert loaded.created_at.astimezone(UTC) == stamp


def test_legacy_naive_row_reads_as_utc(session: Session) -> None:
    """A pre-migration naive string must surface as an AWARE UTC datetime."""
    session.execute(
        sa.text(
            "INSERT INTO runs (run_id, url, page_type, status, failure_mode, "
            "streams_found, tokens_in, tokens_out, tool_calls, duration_seconds, "
            "success, result_json, created_at) "
            "VALUES ('legacy', 'x', 'unknown', 'failed', '', "
            "0, 0, 0, 0, 0, 0, '{}', '2026-01-01 00:00:00.000000')"
        )
    )
    session.commit()
    loaded = session.query(RunRecord).filter_by(run_id="legacy").one()
    assert loaded.created_at.tzinfo is not None
    assert loaded.created_at.astimezone(UTC) == datetime(2026, 1, 1, tzinfo=UTC)


def test_migration_backfill_stamps_naive_strings(tmp_path) -> None:
    """The revision's SQLite backfill appends +00:00 exactly once per value."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "utc_backfill_rev",
        str(Path(__file__).resolve().parents[2] / "alembic" / "versions"
            / "20260826_0020_utc_timestamp_backfill.py"),
    )
    rev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rev)

    engine = sa.create_engine(f"sqlite:///{tmp_path/'backfill.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO runs (run_id, url, page_type, status, failure_mode, "
                "streams_found, tokens_in, tokens_out, tool_calls, duration_seconds, "
                "success, result_json, created_at) "
                "VALUES ('naive', 'x', 'unknown', 'failed', '', "
                "0, 0, 0, 0, 0, 0, '{}', '2026-05-05 05:05:05.000000')"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO runs (run_id, url, page_type, status, failure_mode, "
                "streams_found, tokens_in, tokens_out, tool_calls, duration_seconds, "
                "success, result_json, created_at) "
                "VALUES ('aware', 'x', 'unknown', 'failed', '', "
                "0, 0, 0, 0, 0, 0, '{}', '2026-05-05 05:05:05+00:00')"
            )
        )
        fixed = rev._backfill_sqlite(conn, "runs", "created_at")
        assert fixed == 1
        # Idempotent: second pass fixes nothing.
        assert rev._backfill_sqlite(conn, "runs", "created_at") == 0
        rows = dict(
            conn.execute(sa.text("SELECT run_id, created_at FROM runs")).fetchall()
        )
    assert rows["naive"] == "2026-05-05 05:05:05.000000+00:00"
    assert rows["aware"] == "2026-05-05 05:05:05+00:00"


def test_iso_z_emits_z_suffix_and_handles_naive_none() -> None:
    aware = datetime(2026, 8, 26, 12, 0, 0, tzinfo=UTC)
    assert iso_z(aware) == "2026-08-26T12:00:00Z"

    non_utc = datetime(2026, 8, 26, 14, 0, 0, tzinfo=timezone(timedelta(hours=2)))
    assert iso_z(non_utc) == "2026-08-26T12:00:00Z"

    naive = datetime(2026, 8, 26, 12, 0, 0)
    assert iso_z(naive) == "2026-08-26T12:00:00Z"  # naive interpreted AS UTC

    assert iso_z(None) == ""


def test_to_utc_normalizes_naive_and_offsets() -> None:
    naive = datetime(2026, 8, 26, 12, 0, 0)
    assert to_utc(naive).tzinfo == UTC
    assert to_utc(naive) == datetime(2026, 8, 26, 12, 0, 0, tzinfo=UTC)

    shifted = datetime(2026, 8, 26, 14, 0, 0, tzinfo=timezone(timedelta(hours=2)))
    assert to_utc(shifted).hour == 12
