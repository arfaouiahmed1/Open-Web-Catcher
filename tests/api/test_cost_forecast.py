"""Cost forecasting: POST /api/workflows/estimate + mid-run threshold (plan T12)."""

from __future__ import annotations

import itertools
import uuid
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from src.storage.models import RunModelUsageRecord
from src.storage.repositories import RunRepository
from src.utils.observability import ObservabilityStatus, RunObserver, _RunState

pytestmark = pytest.mark.unit

_id_counter = itertools.count(1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_obs_status() -> ObservabilityStatus:
    return ObservabilityStatus(
        enabled=False,
        project="test",
        default_dataset_name="test",
    )


def _make_observer(max_cost_usd: float | None = None) -> RunObserver:
    state = _RunState(
        run_id=f"run-{uuid.uuid4()}",
        root_actor="test",
        observability=_make_obs_status(),
    )
    obs = RunObserver(state, "test")
    if max_cost_usd is not None:
        obs.set_max_cost_usd(max_cost_usd)
    return obs


def _seed_usage(session, cost_usd: float) -> None:
    """Insert one RunModelUsageRecord with unique keys per row."""
    uid = next(_id_counter)
    session.add(
        RunModelUsageRecord(
            pipeline_run_id=uid,
            provider="test",
            model_name=f"model-{uid}",
            estimated_total_cost_usd=cost_usd,
        )
    )
    session.flush()


# ---------------------------------------------------------------------------
# cost_stats repository method
# ---------------------------------------------------------------------------


class TestCostStats:
    def test_returns_none_percentiles_on_empty_db(self, db_session) -> None:
        repo = RunRepository(db_session)
        stats = repo.cost_stats()
        assert stats["count"] == 0
        assert stats["p50_usd"] is None
        assert stats["p75_usd"] is None

    def test_single_row_percentiles_equal_that_value(self, db_session) -> None:
        _seed_usage(db_session, 0.05)
        db_session.commit()
        repo = RunRepository(db_session)
        stats = repo.cost_stats()
        assert stats["count"] == 1
        assert stats["p50_usd"] == pytest.approx(0.05, abs=1e-6)
        assert stats["p75_usd"] == pytest.approx(0.05, abs=1e-6)

    def test_four_rows_percentiles_correct(self, db_session) -> None:
        for cost in [0.10, 0.20, 0.30, 0.40]:
            _seed_usage(db_session, cost)
        db_session.commit()
        repo = RunRepository(db_session)
        stats = repo.cost_stats()
        assert stats["count"] == 4
        # p50 of [0.10, 0.20, 0.30, 0.40] => index 1.5 => 0.25
        assert stats["p50_usd"] == pytest.approx(0.25, abs=1e-5)
        # p75 of [0.10, 0.20, 0.30, 0.40] => index 2.25 => 0.325
        assert stats["p75_usd"] == pytest.approx(0.325, abs=1e-5)
        assert stats["min_usd"] == pytest.approx(0.10, abs=1e-6)
        assert stats["max_usd"] == pytest.approx(0.40, abs=1e-6)

    def test_zero_cost_rows_excluded(self, db_session) -> None:
        _seed_usage(db_session, 0.0)
        _seed_usage(db_session, 0.10)
        db_session.commit()
        repo = RunRepository(db_session)
        stats = repo.cost_stats()
        assert stats["count"] == 1  # zero-cost row excluded
        assert stats["p50_usd"] == pytest.approx(0.10, abs=1e-6)


# ---------------------------------------------------------------------------
# POST /api/workflows/estimate endpoint
# ---------------------------------------------------------------------------


@pytest.fixture()
def api_client(monkeypatch: pytest.MonkeyPatch, db_session) -> Iterator[Any]:
    """TestClient with auth bypassed via dependency_overrides + DB session patched."""
    from fastapi.testclient import TestClient

    import src.api.app as api_app
    from src.api.auth.dependencies import get_current_user

    # Override the global auth dependency that gates every route.
    def _bypass_auth():
        return SimpleNamespace(email="admin@test.local", role="admin", is_active=True)

    api_app.app.dependency_overrides[get_current_user] = _bypass_auth

    # Patch get_session in app module so the estimate endpoint uses our in-memory DB.
    monkeypatch.setattr(api_app, "get_session", lambda: db_session)

    try:
        yield TestClient(api_app.app)
    finally:
        api_app.app.dependency_overrides.pop(get_current_user, None)


class TestEstimateEndpoint:
    def test_no_history_returns_null_percentiles(self, api_client) -> None:
        resp = api_client.post("/api/workflows/estimate?url_count=1")
        assert resp.status_code == 200
        body = resp.json()
        assert body["p50_total_usd"] is None
        assert body["historical_run_count"] == 0

    def test_with_history_returns_scaled_range(self, api_client, db_session) -> None:
        for cost in [0.10, 0.20, 0.30]:
            _seed_usage(db_session, cost)
        db_session.commit()

        resp = api_client.post("/api/workflows/estimate?url_count=2")
        assert resp.status_code == 200
        body = resp.json()
        assert body["historical_run_count"] == 3
        assert body["url_count"] == 2
        # p50 of [0.10, 0.20, 0.30] = 0.20; x2 = 0.40
        assert body["p50_total_usd"] == pytest.approx(0.40, abs=1e-5)
        assert body["p75_total_usd"] >= body["p50_total_usd"]

    def test_url_count_scales_totals(self, api_client, db_session) -> None:
        _seed_usage(db_session, 0.50)
        db_session.commit()

        resp1 = api_client.post("/api/workflows/estimate?url_count=1")
        resp3 = api_client.post("/api/workflows/estimate?url_count=3")
        assert resp1.status_code == 200
        assert resp3.status_code == 200
        b1 = resp1.json()
        b3 = resp3.json()
        assert b3["p50_total_usd"] == pytest.approx(b1["p50_total_usd"] * 3, abs=1e-5)


# ---------------------------------------------------------------------------
# Mid-run cost threshold + request_cancel
# ---------------------------------------------------------------------------


class TestCostThreshold:
    def test_no_threshold_no_cancel(self) -> None:
        obs = _make_observer(max_cost_usd=None)
        obs.add_llm_usage(
            {"input_tokens": 0, "output_tokens": 0},
            pricing={"input_per_million": 10.0, "output_per_million": 10.0},
        )
        assert not obs.is_cancel_requested()

    def test_threshold_not_yet_reached_no_cancel(self) -> None:
        obs = _make_observer(max_cost_usd=1.0)
        obs.add_llm_usage(
            {"input_tokens": 1000, "output_tokens": 500},
            pricing={"input_per_million": 1.0, "output_per_million": 1.0},
        )
        assert not obs.is_cancel_requested()

    def test_threshold_reached_triggers_cancel(self) -> None:
        obs = _make_observer(max_cost_usd=0.001)
        obs.add_llm_usage(
            {"input_tokens": 100_000, "output_tokens": 100_000},
            pricing={"input_per_million": 1.0, "output_per_million": 1.0},
        )
        assert obs.is_cancel_requested()

    def test_cost_threshold_exceeded_event_emitted(self) -> None:
        obs = _make_observer(max_cost_usd=0.001)
        obs.add_llm_usage(
            {"input_tokens": 100_000, "output_tokens": 100_000},
            pricing={"input_per_million": 1.0, "output_per_million": 1.0},
        )
        kinds = [e.kind for e in obs.trace().events]
        assert "cost_threshold_exceeded" in kinds

    def test_threshold_fires_only_once(self) -> None:
        obs = _make_observer(max_cost_usd=0.001)
        for _ in range(3):
            obs.add_llm_usage(
                {"input_tokens": 100_000, "output_tokens": 100_000},
                pricing={"input_per_million": 1.0, "output_per_million": 1.0},
            )
        exceeded_events = [e for e in obs.trace().events if e.kind == "cost_threshold_exceeded"]
        assert len(exceeded_events) == 1

    def test_set_max_cost_usd_applied_before_first_call(self) -> None:
        obs = _make_observer(max_cost_usd=None)
        obs.set_max_cost_usd(0.001)
        obs.add_llm_usage(
            {"input_tokens": 100_000, "output_tokens": 100_000},
            pricing={"input_per_million": 1.0, "output_per_million": 1.0},
        )
        assert obs.is_cancel_requested()


# ---------------------------------------------------------------------------
# WorkflowRunRequest schema includes max_cost_usd
# ---------------------------------------------------------------------------


class TestWorkflowRunRequestSchema:
    def test_max_cost_usd_defaults_to_none(self) -> None:
        from src.models.schemas import WorkflowRunRequest

        req = WorkflowRunRequest(url="https://example.com")
        assert req.max_cost_usd is None

    def test_max_cost_usd_accepted(self) -> None:
        from src.models.schemas import WorkflowRunRequest

        req = WorkflowRunRequest(url="https://example.com", max_cost_usd=2.50)
        assert req.max_cost_usd == pytest.approx(2.50)


# ---------------------------------------------------------------------------
# max_cost_usd plumbing through background-job fallback path
# ---------------------------------------------------------------------------


class TestFallbackPlumbing:
    def test_fallback_path_forwards_max_cost_usd(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When the background-job table is unavailable the in-memory fallback
        must still forward max_cost_usd to the workflow runner."""
        import asyncio

        from sqlalchemy.exc import SQLAlchemyError

        import src.api.app as api_app

        captured: dict[str, Any] = {}

        async def fake_workflow(
            run_id: str, url: str, max_cost_usd: float | None = None
        ) -> dict[str, Any]:
            captured["max_cost_usd"] = max_cost_usd
            return {"ok": True}

        class FailingRepo:
            def __init__(self, session: Any) -> None:
                pass

            def enqueue(self, **kwargs: Any) -> None:
                raise SQLAlchemyError("background job table unavailable")

        fake_session = SimpleNamespace(close=lambda: None)
        monkeypatch.setattr(api_app, "get_session", lambda: fake_session)
        monkeypatch.setattr(api_app, "BackgroundJobRepository", FailingRepo)
        monkeypatch.setattr(api_app, "_background_workflow", fake_workflow)
        monkeypatch.setattr(api_app, "_track_run_task", lambda run_id, task: task)

        async def _main() -> None:
            resp = api_app._enqueue_background_job(
                run_id="run-fallback-1",
                job_type="workflow",
                url="https://example.com",
                actor="orchestrator",
                payload={"url": "https://example.com", "max_cost_usd": 1.25},
                idempotency_key="",
            )
            assert resp.get("fallback") == "in_memory"
            await asyncio.sleep(0)  # let the scheduled workflow task run

        asyncio.run(_main())
        assert captured["max_cost_usd"] == pytest.approx(1.25)


class TestThresholdEventSseShape:
    def test_threshold_event_survives_sse_normalization(self) -> None:
        from src.storage.repositories import normalize_runtime_event_payload

        obs = _make_observer(max_cost_usd=0.001)
        obs.add_llm_usage(
            {"input_tokens": 100_000, "output_tokens": 100_000},
            pricing={"input_per_million": 1.0, "output_per_million": 1.0},
        )
        evt = next(e for e in obs.trace().events if e.kind == "cost_threshold_exceeded")
        payload = normalize_runtime_event_payload(evt.model_dump(mode="json"))
        assert payload["kind"] == "cost_threshold_exceeded"
