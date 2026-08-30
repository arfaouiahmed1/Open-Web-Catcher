"""Security quick-win regressions: gated docs, headers, CORS hardening, atomic bootstrap."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import _cors_origins
from src.api.auth import dependencies as auth_dependencies
from src.api.auth import router as auth_router_module
from src.api.auth import security as auth_security
from src.storage.models import UserRecord
from src.utils.config import Settings

pytestmark = pytest.mark.unit

TEST_SECRET = "unit-test-secret-for-security-headers"
ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "admin-password-123"


@pytest.fixture()
def client(
    monkeypatch: pytest.MonkeyPatch, session_factory
) -> Iterator[TestClient]:
    bind = session_factory.kw["bind"]
    UserRecord.metadata.create_all(bind=bind)

    def _override_session():
        return session_factory()

    monkeypatch.setattr(auth_dependencies, "get_session", _override_session)
    monkeypatch.setattr(auth_router_module, "get_session", _override_session)

    settings = Settings()
    monkeypatch.setattr(settings, "auth_jwt_secret", TEST_SECRET)
    monkeypatch.setattr(auth_security, "_auth_settings", lambda: settings)

    from src.api.app import app

    yield TestClient(app)


def _admin_headers() -> dict[str, str]:
    token = auth_security.create_access_token(
        email=ADMIN_EMAIL,
        role="admin",
        secret=TEST_SECRET,
        expires_minutes=60,
    )
    return {"Authorization": f"Bearer {token}"}


def test_docs_endpoints_rejected_without_token(client: TestClient):
    for path in ("/openapi.json", "/docs", "/redoc"):
        response = client.get(path)
        assert response.status_code == 401, path


def test_docs_endpoints_serve_with_admin_token(client: TestClient):
    created = client.post(
        "/api/auth/bootstrap-admin",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    assert created.status_code == 200
    headers = _admin_headers()
    assert client.get("/openapi.json", headers=headers).status_code == 200
    assert client.get("/docs", headers=headers).status_code == 200
    assert client.get("/redoc", headers=headers).status_code == 200


def test_security_headers_present_on_responses(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]


def test_cors_origins_resolver_rejects_wildcard(monkeypatch: pytest.MonkeyPatch):
    settings = Settings()
    monkeypatch.setattr(settings, "ui_cors_origins", "*, http://localhost:3000 ,https://owc.example")
    resolved = _cors_origins(settings)
    assert "*" not in resolved
    assert resolved == ["http://localhost:3000", "https://owc.example"]


def test_cors_origins_resolver_keeps_explicit_list(monkeypatch: pytest.MonkeyPatch):
    settings = Settings()
    monkeypatch.setattr(settings, "ui_cors_origins", "http://a.test, http://b.test")
    assert _cors_origins(settings) == ["http://a.test", "http://b.test"]


def test_bootstrap_admin_atomic_single_winner(client: TestClient):
    def _attempt(email: str) -> dict:
        response = client.post(
            "/api/auth/bootstrap-admin",
            json={"email": email, "password": ADMIN_PASSWORD},
        )
        return response.json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(_attempt, ["first@test.local", "second@test.local"]))

    created_flags = sorted(entry["created"] for entry in outcomes)
    assert created_flags == [False, True]

    session = auth_router_module.get_session()
    try:
        users = session.query(UserRecord).all()
        assert len(users) == 1
        assert users[0].role == "admin"
    finally:
        session.close()
