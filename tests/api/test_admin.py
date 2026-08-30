"""Admin API matrix (plan T35): role gating, users CRUD, model-performance
metrics (SUM fix), prompt-version rollback, agent-tests runner, cost deltas."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from src.api import admin as admin_module
from src.api.auth import dependencies as auth_dependencies
from src.api.auth import router as auth_router_module
from src.api.auth import security as auth_security
from src.storage.models import (
    AgentRunRecord,
    BackgroundJobRecord,
    LLMCallRecord,
    PricingConfigRecord,
    PromptVersionRecord,
    RunModelUsageRecord,
    UserRecord,
)
from src.utils.config import Settings

pytestmark = pytest.mark.unit

TEST_SECRET = "unit-test-secret-for-admin-apis"
ADMIN_EMAIL = "admin@test.local"
VIEWER_EMAIL = "viewer@test.local"

# Every admin route: (method, path) — the role-gate 403 matrix iterates these.
ADMIN_ROUTES = [
    ("GET", "/api/admin/users"),
    ("POST", "/api/admin/users"),
    ("PATCH", "/api/admin/users/1"),
    ("DELETE", "/api/admin/users/1"),
    ("GET", "/api/admin/metrics/model-performance"),
    ("GET", "/api/admin/prompt-versions"),
    ("GET", "/api/admin/prompt-versions/diff?from=1&to=2"),
    ("GET", "/api/admin/prompt-versions/1"),
    ("POST", "/api/admin/prompt-versions/1/activate"),
    ("POST", "/api/admin/agent-tests"),
    ("GET", "/api/admin/agent-tests"),
    ("GET", "/api/admin/agent-tests/some-run-id"),
    ("GET", "/api/admin/costs"),
]

_ROUTE_BODIES = {
    ("POST", "/api/admin/users"): {
        "email": "new@test.local",
        "password": "a-strong-password",
        "role": "viewer",
    },
    ("PATCH", "/api/admin/users/1"): {"is_active": False},
    ("POST", "/api/admin/prompt-versions/1/activate"): {},
    ("POST", "/api/admin/agent-tests"): {"agent": "landing_page", "url": "https://example.com"},
}


@pytest.fixture()
def api(
    monkeypatch: pytest.MonkeyPatch, session_factory
) -> Iterator[TestClient]:
    bind = session_factory.kw["bind"]
    UserRecord.metadata.create_all(bind=bind)

    def _override_session():
        return session_factory()

    monkeypatch.setattr(auth_dependencies, "get_session", _override_session)
    monkeypatch.setattr(auth_router_module, "get_session", _override_session)
    monkeypatch.setattr(admin_module, "get_session", _override_session)

    settings = Settings()
    monkeypatch.setattr(settings, "auth_jwt_secret", TEST_SECRET)
    monkeypatch.setattr(auth_security, "_auth_settings", lambda: settings)

    from src.api.app import app

    yield TestClient(app)


def _mint_token(email: str, role: str) -> str:
    return auth_security.create_access_token(
        email=email, role=role, secret=TEST_SECRET, expires_minutes=60
    )


def _admin_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_token(ADMIN_EMAIL, 'admin')}"}


def _viewer_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_token(VIEWER_EMAIL, 'viewer')}"}


def _seed_users(session_factory) -> None:
    session = session_factory()
    try:
        session.add(
            UserRecord(
                email=ADMIN_EMAIL,
                password_hash=auth_security.hash_password("unused-admin-pass"),
                role="admin",
                is_active=True,
            )
        )
        session.add(
            UserRecord(
                email=VIEWER_EMAIL,
                password_hash=auth_security.hash_password("unused-viewer-pass"),
                role="viewer",
                is_active=True,
            )
        )
        session.commit()
    finally:
        session.close()


# ── Role-gate matrix ──────────────────────────────────────────────────────


@pytest.mark.parametrize("method,path", ADMIN_ROUTES)
def test_admin_routes_reject_unauthenticated(api: TestClient, method: str, path: str):
    response = api.request(method, path, json=_ROUTE_BODIES.get((method, path)))
    assert response.status_code == 401, response.text


@pytest.mark.parametrize("method,path", ADMIN_ROUTES)
def test_admin_routes_reject_non_admin_roles_403(
    api: TestClient, session_factory, method: str, path: str
):
    _seed_users(session_factory)
    response = api.request(
        method, path, json=_ROUTE_BODIES.get((method, path)), headers=_viewer_headers()
    )
    assert response.status_code == 403, response.text
    assert "admin" in response.json()["detail"]


@pytest.mark.parametrize("role", ["operator", "unknown-role"])
def test_operator_and_bogus_roles_also_403(api: TestClient, session_factory, role: str):
    _seed_users(session_factory)
    session = session_factory()
    try:
        session.add(
            UserRecord(
                email=f"{role}@test.local",
                password_hash="x",
                role=role if role in ("admin", "operator", "viewer") else "viewer",
                is_active=True,
            )
        )
        session.commit()
    finally:
        session.close()
    token = _mint_token(f"{role}@test.local", role if role != "unknown-role" else "operator")
    response = api.get("/api/admin/users", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 403


def test_admin_role_can_access_routes(api: TestClient, session_factory):
    _seed_users(session_factory)
    assert api.get("/api/admin/users", headers=_admin_headers()).status_code == 200


# ── Users CRUD ────────────────────────────────────────────────────────────


def test_users_crud_lifecycle(api: TestClient, session_factory):
    _seed_users(session_factory)
    headers = _admin_headers()

    created = api.post(
        "/api/admin/users",
        json={
            "email": "New_Operator@Test.Local",
            "password": "strong-pass-123",
            "role": "operator",
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()
    user_id = body["id"]
    assert body["email"] == "new_operator@test.local"
    assert body["role"] == "operator"
    assert body["is_active"] is True

    duplicate = api.post(
        "/api/admin/users",
        json={"email": "new_operator@test.local", "password": "strong-pass-123"},
        headers=headers,
    )
    assert duplicate.status_code == 409

    bad_role = api.post(
        "/api/admin/users",
        json={"email": "x@test.local", "password": "strong-pass-123", "role": "superuser"},
        headers=headers,
    )
    assert bad_role.status_code == 400

    updated = api.patch(
        f"/api/admin/users/{user_id}", json={"role": "viewer"}, headers=headers
    )
    assert updated.status_code == 200
    assert updated.json()["role"] == "viewer"

    deactivated = api.patch(
        f"/api/admin/users/{user_id}", json={"is_active": False}, headers=headers
    )
    assert deactivated.json()["is_active"] is False

    listed = api.get("/api/admin/users", headers=headers)
    emails = [row["email"] for row in listed.json()["users"]]
    assert emails == [ADMIN_EMAIL, VIEWER_EMAIL, "new_operator@test.local"]

    deleted = api.delete(f"/api/admin/users/{user_id}", headers=headers)
    assert deleted.status_code == 200
    listed_after = api.get("/api/admin/users", headers=headers).json()["users"]
    assert user_id not in [row["id"] for row in listed_after]


def test_user_self_protection_guards(api: TestClient, session_factory):
    _seed_users(session_factory)
    headers = _admin_headers()

    assert api.get("/api/auth/me", headers=headers).status_code == 200
    listed = api.get("/api/admin/users", headers=headers).json()["users"]
    me_row = next(row for row in listed if row["email"] == ADMIN_EMAIL)

    self_deactivate = api.patch(
        f"/api/admin/users/{me_row['id']}", json={"is_active": False}, headers=headers
    )
    assert self_deactivate.status_code == 400

    self_demote = api.patch(
        f"/api/admin/users/{me_row['id']}", json={"role": "viewer"}, headers=headers
    )
    assert self_demote.status_code == 400

    self_delete = api.delete(f"/api/admin/users/{me_row['id']}", headers=headers)
    assert self_delete.status_code == 400


def test_cannot_delete_last_remaining_admin(api: TestClient, session_factory):
    """The guard is defense-in-depth: through the API it is shadowed by the
    self-delete block, so exercise it directly against the route handler."""
    _seed_users(session_factory)

    def _override_session():
        return session_factory()

    admin_module.get_session = _override_session  # route reads via module global

    session = session_factory()
    try:
        admin_row = (
            session.query(UserRecord).filter(UserRecord.email == ADMIN_EMAIL).one()
        )
        admin_id = int(admin_row.id)
    finally:
        session.close()

    # Phantom admin identity (not in DB) deletes the only real admin:
    # remaining admins excluding the target = 0 -> refused.
    phantom = UserRecord(id=9999, email="ghost@test.local", role="admin", is_active=True)
    with pytest.raises(HTTPException) as excinfo:
        admin_module.delete_user(user_id=admin_id, admin=phantom)
    assert excinfo.value.status_code == 400
    assert "last remaining admin" in excinfo.value.detail


# ── Model-performance metrics (SUM fix) ───────────────────────────────────


def test_model_performance_metrics_sum_across_runs(api: TestClient, session_factory):
    _seed_users(session_factory)

    def add_usage(
        run_id: int, calls: int, cache_hits: int, tokens_in: int, tokens_out: int, cost: float
    ):
        return RunModelUsageRecord(
            pipeline_run_id=run_id,
            provider="google",
            model_name="gemini-pro",
            llm_calls=calls,
            cache_hit_calls=cache_hits,
            input_tokens=tokens_in,
            cached_input_tokens=cache_hits * 10,
            new_input_tokens=tokens_in - cache_hits * 10,
            output_tokens=tokens_out,
            estimated_total_cost_usd=cost,
        )

    session = session_factory()
    try:
        # two runs on the SAME model: SUM must be 5 calls, not MAX of 3.
        session.add(add_usage(1, calls=2, cache_hits=1, tokens_in=110, tokens_out=20, cost=0.01))
        session.add(add_usage(2, calls=3, cache_hits=2, tokens_in=220, tokens_out=30, cost=0.02))
        # second model, zero usage rows beyond this one
        session.add(
            RunModelUsageRecord(
                pipeline_run_id=3,
                provider="anthropic",
                model_name="claude-haiku",
                llm_calls=4,
                cache_hit_calls=0,
                input_tokens=400,
                output_tokens=40,
                estimated_total_cost_usd=0.04,
            )
        )
        for agent_run_id, duration in ((1, 1.0), (2, 3.0)):
            session.add(
                AgentRunRecord(
                    pipeline_run_id=agent_run_id,
                    actor="classification",
                    agent_type="classification",
                    provider="google",
                    model_name="gemini-pro",
                    status="success",
                    duration_seconds=duration,
                )
            )
        session.commit()
    finally:
        session.close()

    payload = api.get(
        "/api/admin/metrics/model-performance", headers=_admin_headers()
    ).json()
    by_model = {(row["provider"], row["model_name"]): row for row in payload["models"]}
    gemini = by_model[("google", "gemini-pro")]
    assert gemini["calls"] == 5  # SUM(2, 3) — a MAX would have returned 3
    assert gemini["cache_hit_calls"] == 3
    assert gemini["cache_hit_rate"] == round(3 / 5, 4)
    assert gemini["total_tokens"] == 330 + 50
    assert gemini["cost_usd"] == pytest.approx(0.03)
    assert gemini["p50_latency_seconds"] == 2.0  # p50 of [1.0, 3.0]
    claude = by_model[("anthropic", "claude-haiku")]
    assert claude["p50_latency_seconds"] is None
    assert claude["latency_samples"] == 0


# ── Prompt versions: list / diff / activate-rollback ─────────────────────


def _seed_prompt_versions(session_factory, tmp_path) -> tuple[int, int, Path]:
    """v1 (older, inactive) and v2 (current, active) for the same agent."""
    _seed_users(session_factory)
    prompt_file = tmp_path / "landing_page_v1.md"
    v1_text = "# Landing prompt\n\nOLD RULES"
    v2_text = "# Landing prompt\n\nNEW RULES"
    prompt_file.write_text(v2_text, encoding="utf-8")
    session = session_factory()
    try:
        record_v1 = PromptVersionRecord(
            agent_id="landing_page",
            source_path=str(prompt_file),
            semantic_version="v1",
            content_hash="hash-v1",
            prompt_text=v1_text,
            active=False,
        )
        record_v2 = PromptVersionRecord(
            agent_id="landing_page",
            source_path=str(prompt_file),
            semantic_version="v2",
            content_hash="hash-v2",
            prompt_text=v2_text,
            active=True,
        )
        session.add_all([record_v1, record_v2])
        session.commit()
        return record_v1.id, record_v2.id, prompt_file
    finally:
        session.close()


def test_prompt_versions_list_and_get(api: TestClient, session_factory, tmp_path):
    v1_id, v2_id, _ = _seed_prompt_versions(session_factory, tmp_path)
    headers = _admin_headers()

    listing = api.get("/api/admin/prompt-versions", headers=headers).json()
    assert listing["total"] == 2
    assert all("prompt_text" not in row for row in listing["versions"])

    filtered = api.get(
        "/api/admin/prompt-versions", params={"agent_id": "landing_page"}, headers=headers
    ).json()
    assert filtered["total"] == 2

    detail = api.get(f"/api/admin/prompt-versions/{v1_id}", headers=headers).json()
    assert detail["prompt_text"].endswith("OLD RULES")

    assert (
        api.get("/api/admin/prompt-versions/99999", headers=headers).status_code == 404
    )


def test_prompt_version_diff_endpoint(api: TestClient, session_factory, tmp_path):
    v1_id, v2_id, _ = _seed_prompt_versions(session_factory, tmp_path)
    headers = _admin_headers()
    diff = api.get(
        "/api/admin/prompt-versions/diff",
        params={"from": v1_id, "to": v2_id},
        headers=headers,
    )
    assert diff.status_code == 200
    body = diff.json()
    assert body["identical"] is False
    assert "-OLD RULES" in body["diff"]
    assert "+NEW RULES" in body["diff"]


def test_prompt_version_activate_flips_active_version_used_next_compile(
    api: TestClient, session_factory, tmp_path
):
    v1_id, v2_id, prompt_file = _seed_prompt_versions(session_factory, tmp_path)
    headers = _admin_headers()

    response = api.post(f"/api/admin/prompt-versions/{v1_id}/activate", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["active"] is True
    assert body["restored_to_disk"] is True

    # DB flags flipped: exactly v1 active for the agent.
    session = session_factory()
    try:
        rows = session.query(PromptVersionRecord).order_by(PromptVersionRecord.id).all()
        flags = {row.semantic_version: row.active for row in rows}
        assert flags == {"v1": True, "v2": False}
    finally:
        session.close()

    # The on-disk prompt file was restored to v1's text, so the NEXT compile —
    # which reads configs/prompts/*.md and hashes the file content — resolves
    # to v1's content_hash instead of v2's.
    assert prompt_file.read_text(encoding="utf-8").endswith("OLD RULES")

    unknown = api.post("/api/admin/prompt-versions/99999/activate", headers=headers)
    assert unknown.status_code == 404


# ── Agent tests runner ────────────────────────────────────────────────────


def test_agent_tests_launch_and_list_results(api: TestClient, session_factory):
    _seed_users(session_factory)
    headers = _admin_headers()

    launched = api.post(
        "/api/admin/agent-tests",
        json={"agent": "landing_page", "url": "https://example.com/replay", "prompt_override": ""},
        headers=headers,
    )
    assert launched.status_code == 202, launched.text
    body = launched.json()
    assert body["status"] == "queued"
    run_id = body["run_id"]

    session = session_factory()
    try:
        job = session.query(BackgroundJobRecord).filter_by(run_id=run_id).one()
        assert job.job_type == "agent"
        assert job.payload_json["replay_target"] == "https://example.com/replay"
        assert job.payload_json["launched_by"] == ADMIN_EMAIL
        # mark it finished so list results carry terminal state
        job.status = "succeeded"
        job.result_json = {"summary": "done"}
        session.commit()
    finally:
        session.close()

    results = api.get("/api/admin/agent-tests", headers=headers).json()
    assert results["total"] >= 1
    match = next(t for t in results["tests"] if t["run_id"] == run_id)
    assert match["status"] == "succeeded"
    assert match["result_summary"] == "done"

    single = api.get(f"/api/admin/agent-tests/{run_id}", headers=headers).json()
    assert single["payload"]["agent"] == "landing_page"


# ── Cost deltas ───────────────────────────────────────────────────────────


def test_cost_deltas_actuals_vs_estimate(api: TestClient, session_factory):
    _seed_users(session_factory)
    session = session_factory()
    try:
        session.add(
            PricingConfigRecord(
                provider="google",
                model_name="gemini-pro",
                input_per_million=1.0,
                output_per_million=2.0,
                cached_input_per_million=0.25,
            )
        )
        # recorded estimate: $0.010; expected at current rates below.
        session.add(
            LLMCallRecord(
                agent_run_id=1,
                seq=1,
                provider="google",
                model_name="gemini-pro",
                input_tokens=1_000_000,
                cached_input_tokens=0,
                new_input_tokens=1_000_000,
                output_tokens=500_000,
                estimated_total_cost_usd=0.01,
                estimated_input_cost_usd=0.01,
            )
        )
        session.commit()
    finally:
        session.close()

    payload = api.get("/api/admin/costs", headers=_admin_headers()).json()
    assert payload["models"], payload
    row = payload["models"][0]
    assert row["priced"] is True
    # expected = (1e6*1.0 + 0 + 5e5*2.0)/1e6 = 2.00 USD vs 0.01 recorded
    assert row["expected_cost_usd"] == pytest.approx(2.0, abs=1e-6)
    assert row["delta_usd"] == pytest.approx(0.01 - 2.0, abs=1e-6)
    assert payload["totals"]["delta_usd"] == pytest.approx(0.01 - 2.0, abs=1e-6)
