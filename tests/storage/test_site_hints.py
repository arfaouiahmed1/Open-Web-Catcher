"""Site-hint pgvector memory (plan task 18, phase 1).

Covers CRUD, TTL pruning, semantic-search ordering, and the summarizer write
path — all against in-memory SQLite. Embeddings are fake float vectors (no
network, no encoder); on SQLite they persist as JSON lists and ranking uses
the repository's Python-side cosine fallback, so the suite stays green
without the pgvector extension or a Postgres server. Assertions that require
the actual ``pgvector`` package are guarded with ``pytest.importorskip``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.memory.site_hint_writer import summarize_raw_entry, write_site_hint
from src.storage.models import Base, EmbeddingVector, SiteHintRecord
from src.storage.repositories import SiteHintRepository


@pytest.fixture()
def session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture()
def session(session_factory):
    db = session_factory()
    try:
        yield db
    finally:
        db.close()


# --------------------------------------------------------------------- CRUD


def test_upsert_hint_creates_then_updates_same_row(session: object) -> None:
    repo = SiteHintRepository(session)

    created = repo.upsert_hint(
        domain="https://www.ExampleStream.tv/watch",
        page_type="landing_page",
        summary_text="landing run success | hosting pages found=3",
        navigation_steps=["1: navigate used url=https://examplestream.tv"],
        selectors=["title=Live Sports HD"],
        success_rate=1.0,
    )
    assert created.id is not None
    # Domain normalized to bare host.
    assert created.domain == "examplestream.tv"
    assert created.success_rate == pytest.approx(1.0)

    updated = repo.upsert_hint(
        domain="examplestream.tv",
        page_type="landing_page",
        summary_text="refreshed",
        navigation_steps=["2: click used selector=.play"],
        success_rate=0.0,
    )
    assert updated.id == created.id
    rows = session.query(SiteHintRecord).all()
    assert len(rows) == 1
    assert rows[0].summary_text == "refreshed"
    assert rows[0].navigation_steps == ["2: click used selector=.play"]
    # EMA blend of 1.0 then 0.0 with alpha=0.5.
    assert rows[0].success_rate == pytest.approx(0.5)


def test_get_hints_filters_domain_and_page_type_with_limit(session: object) -> None:
    repo = SiteHintRepository(session)
    for page_type in ("landing_page", "hosting_page", "embedded_page"):
        for domain in ("alpha.tv", "beta.tv"):
            repo.upsert_hint(
                domain=domain,
                page_type=page_type,
                summary_text=f"{domain}/{page_type}",
            )

    alpha_landing = repo.get_hints(domain="ALPHA.TV", page_type="landing_page")
    assert len(alpha_landing) == 1
    assert alpha_landing[0].page_type == "landing_page"
    assert alpha_landing[0].domain == "alpha.tv"

    all_alpha = repo.get_hints(domain="alpha.tv", limit=2)
    assert len(all_alpha) == 2

    everything = repo.get_hints(limit=10)
    assert len(everything) == 6


def test_prune_expired_removes_only_expired_rows(session: object) -> None:
    repo = SiteHintRepository(session)
    now = datetime.now(UTC)

    repo.upsert_hint(
        domain="stale.tv",
        page_type="landing_page",
        summary_text="old",
        ttl_expires_at=now - timedelta(days=1),
    )
    fresh = repo.upsert_hint(
        domain="fresh.tv",
        page_type="hosting_page",
        summary_text="new",
        ttl_expires_at=now + timedelta(days=7),
    )
    forever = repo.upsert_hint(domain="eternal.tv", page_type="unknown", summary_text="no ttl")

    pruned = repo.prune_expired(now=now)
    assert pruned == 1

    remaining_domains = {row.domain for row in session.query(SiteHintRecord).all()}
    assert remaining_domains == {"fresh.tv", "eternal.tv"}
    assert fresh.ttl_expires_at is not None
    assert forever.ttl_expires_at is None


# ------------------------------------------------------------ semantic search


def _vec(*weights_by_axis: tuple[int, float], dim: int = 8) -> list[float]:
    """Fake embedding: unit-ish spike on chosen axes (no network/encoder)."""
    vector = [0.0] * dim
    for axis, weight in weights_by_axis:
        vector[axis] = weight
    return vector


def test_search_semantic_orders_by_cosine_distance_and_filters_domain(
    session: object,
) -> None:
    repo = SiteHintRepository(session)
    landing_like = _vec((0, 1.0), (1, 0.5))
    hosting_like = _vec((2, 1.0))
    # Orthogonal to the query direction below -> clearly worse than landing_like.
    other_domain = _vec((3, 1.0))

    repo.upsert_hint(
        domain="close.tv",
        page_type="landing_page",
        summary_text="closest match",
        embedding=landing_like,
    )
    repo.upsert_hint(
        domain="close.tv",
        page_type="hosting_page",
        summary_text="orthogonal match",
        embedding=hosting_like,
    )
    repo.upsert_hint(
        domain="far.tv",
        page_type="landing_page",
        summary_text="right direction wrong domain",
        embedding=other_domain,
    )

    query = _vec((0, 1.0), (1, 0.45))

    ranked = repo.search_semantic(query)
    assert [row.summary_text for row in ranked][:1] == ["closest match"]
    assert len(ranked) == 3
    distances = [row.semantic_distance for row in ranked]
    assert distances == sorted(distances)

    scoped = repo.search_semantic(query, domain="far.tv")
    assert [row.summary_text for row in scoped] == ["right direction wrong domain"]

    typed = repo.search_semantic(query, page_type="hosting_page")
    assert [row.summary_text for row in typed] == ["orthogonal match"]


def test_search_semantic_ignores_rows_without_embedding(session: object) -> None:
    repo = SiteHintRepository(session)
    repo.upsert_hint(domain="novec.tv", page_type="unknown", summary_text="no vector")

    assert repo.search_semantic(_vec((0, 1.0))) == []


# ----------------------------------------------------------------- summarizer


def _raw_entry(**overrides: object) -> dict[str, object]:
    entry = {
        "domain": "examplestream.tv",
        "url": "https://www.examplestream.tv/watch/live",
        "page_type": "landing_page",
        "status": "success",
        "success": True,
        "tool_sequence": ["navigate", "click", "extract_links"],
        "tool_steps": ["navigate(url=https://www.examplestream.tv)", "click(selector=.play)"],
        "navigation_targets": ["url=https://www.examplestream.tv/watch/live"],
        "selectors": ["title=Live Sports HD", "channel=Sports 1"],
        "playbook_steps": [
            "1: navigate used url=https://www.examplestream.tv",
            "2: click used selector=.play",
        ],
        "activated_servers": ["ServerA", "ServerB"],
        "failure_cues": [],
        "short_memory_summary": "found 4 hosting candidates via sports nav bar",
        "result_summary": "landing run success; hosting pages found=4",
    }
    entry.update(overrides)
    return entry


def test_summarize_raw_entry_builds_summary_and_steps() -> None:
    distilled = summarize_raw_entry(_raw_entry())

    assert "landing_page run success" in distilled["summary_text"]
    assert "found 4 hosting candidates via sports nav bar" in distilled["summary_text"]
    assert distilled["navigation_steps"][0].startswith("1: navigate")
    assert distilled["selectors"] == ["title=Live Sports HD", "channel=Sports 1"]
    assert distilled["success_rate"] == 1.0

    failed = summarize_raw_entry(
        _raw_entry(status="failed", success=False, failure_cues=["stop_reason=max_tool_calls"])
    )
    assert "failed" in failed["summary_text"]
    assert "stop_reason=max_tool_calls" in failed["summary_text"]
    assert failed["success_rate"] == 0.0


def test_write_site_hint_persists_through_repository(session: object) -> None:
    record = write_site_hint(
        session,
        domain="https://www.examplestream.tv/watch/live",
        page_type="landing_page",
        raw_entry=_raw_entry(),
        embedding=_vec((0, 1.0)),
    )

    assert record.domain == "examplestream.tv"  # URL normalized to bare host
    assert record.summary_text.startswith("landing_page run success")
    assert record.navigation_steps
    assert record.embedding == _vec((0, 1.0))
    assert record.ttl_expires_at is not None and record.ttl_expires_at > datetime.now(UTC)

    hits = SiteHintRepository(session).search_semantic(
        _vec((0, 0.95)), domain="examplestream.tv"
    )
    assert [row.id for row in hits] == [record.id]


def test_write_site_hint_respects_explicit_ttl(session: object) -> None:
    expires = datetime(2030, 1, 1, tzinfo=UTC)
    record = write_site_hint(
        session,
        domain="ttl.tv",
        page_type="embedded_page",
        raw_entry=_raw_entry(page_type="embedded_page"),
        ttl_expires_at=expires,
    )
    assert record.ttl_expires_at == expires


# --------------------------------------------------- pgvector-specific guards


def test_embedding_type_falls_back_to_json_without_pgvector_dialect() -> None:
    from sqlalchemy import JSON
    from sqlalchemy.dialects import sqlite

    column_type = EmbeddingVector(512)
    # SQLite dialect gets the JSON fallback, not a vector() type.
    compiled = column_type.load_dialect_impl(sqlite.dialect())
    assert isinstance(compiled, JSON)
    # Round-trips a fake vector through bind/result processing unchanged.
    vector = _vec((3, 0.25))
    assert column_type.process_bind_param(vector, sqlite.dialect()) == vector
    assert column_type.process_result_value(vector, sqlite.dialect()) == vector
    assert column_type.process_bind_param(None, sqlite.dialect()) is None


def test_embedding_type_compiles_to_vector_on_postgres() -> None:
    pytest.importorskip("pgvector")
    from sqlalchemy.dialects import postgresql

    from src.storage.models import EMBEDDING_DIMENSIONS, _PgVector

    column_type = EmbeddingVector(EMBEDDING_DIMENSIONS)
    compiled = column_type.load_dialect_impl(postgresql.dialect())
    assert isinstance(compiled, _PgVector)
    assert compiled.dim == EMBEDDING_DIMENSIONS


def test_models_importable_and_metadata_registered() -> None:
    # Parity guard: migration 20260825_0019 must mirror these table names.
    assert {"site_hints", "logo_embeddings"} <= {t.name for t in Base.metadata.sorted_tables}


# ------------------------------------------------------------- concurrency


def _file_session_factory(db_path: object) -> object:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        future=True,
    )
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def test_concurrent_upserts_same_domain_stay_race_safe(tmp_path: object) -> None:
    """Two writers hammering the SAME (domain, page_type) hint must leave
    exactly one row whose EMA success_rate stays within [0, 1] (TXN guard)."""
    import threading

    factory = _file_session_factory(tmp_path / "hints.db")

    errors: list[Exception] = []

    def _writer(worker_id: int) -> None:
        try:
            repo = SiteHintRepository(factory())
            for i in range(15):
                repo.upsert_hint(
                    domain="racetv.example",
                    page_type="landing_page",
                    summary_text=f"writer-{worker_id} pass-{i}",
                    navigation_steps=[f"{i}: navigate used url=https://racetv.example"],
                    success_rate=1.0 if (i + worker_id) % 2 == 0 else 0.0,
                )
        except Exception as exc:  # pragma: no cover - surfaced via assertion below
            errors.append(exc)

    threads = [threading.Thread(target=_writer, args=(worker_id,)) for worker_id in (1, 2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)

    assert not errors, errors
    session = factory()
    try:
        rows = session.query(SiteHintRecord).filter_by(domain="racetv.example").all()
        assert len(rows) == 1
        assert 0.0 <= float(rows[0].success_rate) <= 1.0
    finally:
        session.close()


# ----------------------------------------------- run-start hints + agentic tool


def test_build_run_start_hint_context_injects_once_per_domain(session_factory: object) -> None:
    from src.memory.hints_service import build_run_start_hint_context

    write_site_hint(
        session_factory(),
        domain="https://www.hinted.tv/watch",
        page_type="hosting_page",
        raw_entry=_raw_entry(page_type="hosting_page"),
    )

    block = build_run_start_hint_context(
        "https://www.hinted.tv/watch/live",
        "hosting_page",
        session_factory=session_factory,
    )
    assert block.startswith("SITE HINTS")
    assert "hinted.tv" in block
    assert "playbook:" in block

    # Unknown domain -> empty string so callers skip injection entirely.
    assert (
        build_run_start_hint_context(
            "https://unknown.tv", "hosting_page", session_factory=session_factory
        )
        == ""
    )


def test_memory_search_tool_is_registered_and_returns_ranked_results(
    session_factory: object,
) -> None:
    import json as _json

    from src.memory.agentic_tool import build_memory_search_tool

    write_site_hint(
        session_factory(),
        domain="https://paginated.tv/list",
        page_type="landing_page",
        raw_entry=_raw_entry(
            url="https://paginated.tv/list",
            short_memory_summary="pagination rule page=2 works on match list",
        ),
    )

    tool = build_memory_search_tool(session_factory=session_factory)
    assert tool.name == "memory_search"
    result = _json.loads(tool.invoke({"query": "pagination pattern match list"}))
    assert result["ok"] is True
    assert any(hit["domain"] == "paginated.tv" for hit in result["results"])

    empty = _json.loads(tool.invoke({"query": "zzz-no-such-hint-token-qxyz"}))
    assert empty["ok"] is True and empty["results"] == []
