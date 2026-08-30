"""Auth foundation matrix: global gating, login, roles, bootstrap (plan T3)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from src.api.auth import dependencies as auth_dependencies
from src.api.auth import router as auth_router_module
from src.api.auth import security as auth_security
from src.api.auth.dependencies import require_role
from src.storage.models import UserRecord
from src.utils.config import Settings

pytestmark = pytest.mark.unit

TEST_SECRET = "unit-test-secret-for-auth-foundation"
ADMIN_EMAIL = "admin@test.local"
ADMIN_PASSWORD = "admin-password-123"
VIEWER_EMAIL = "viewer@test.local"


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

    settings = Settings()
    monkeypatch.setattr(settings, "auth_jwt_secret", TEST_SECRET)
    monkeypatch.setattr(auth_security, "_auth_settings", lambda: settings)

    from src.api.app import app

    yield TestClient(app)


def _mint_token(email: str, role: str, expires_minutes: int = 60) -> str:
    return auth_security.create_access_token(
        email=email,
        role=role,
        secret=TEST_SECRET,
        expires_minutes=expires_minutes,
    )


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        "/api/auth/bootstrap-admin",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text


def _insert_viewer(session_factory) -> None:
    session = session_factory()
    try:
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


def test_health_stays_open_without_token(api: TestClient):
    assert api.get("/health").status_code == 200


def test_unauthenticated_real_route_rejected(api: TestClient):
    response = api.get("/ui/overview")
    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"


def test_login_bad_credentials_generic_401(api: TestClient):
    _bootstrap_admin(api)
    for payload in (
        {"email": ADMIN_EMAIL, "password": "wrong-password"},
        {"email": "nobody@test.local", "password": ADMIN_PASSWORD},
    ):
        response = api.post("/api/auth/login", json=payload)
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid email or password"


def test_login_success_returns_token_and_user(api: TestClient):
    _bootstrap_admin(api)
    response = api.post(
        "/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["user"] == {"email": ADMIN_EMAIL, "role": "admin"}


def test_me_returns_current_user_with_token(api: TestClient):
    _bootstrap_admin(api)
    token = _mint_token(ADMIN_EMAIL, "admin")
    assert api.get("/api/auth/me").status_code == 401
    response = api.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    assert response.json()["user"] == {"email": ADMIN_EMAIL, "role": "admin"}


def test_tampered_token_rejected(api: TestClient):
    token = _mint_token(ADMIN_EMAIL, "admin")
    tampered = token[:-3] + ("aaa" if not token.endswith("aaa") else "bbb")
    response = api.get("/ui/overview", headers={"Authorization": f"Bearer {tampered}"})
    assert response.status_code == 401


def test_wrong_secret_token_rejected(api: TestClient):
    foreign = auth_security.create_access_token(
        email=ADMIN_EMAIL, role="admin", secret="another-secret", expires_minutes=60
    )
    response = api.get("/ui/overview", headers={"Authorization": f"Bearer {foreign}"})
    assert response.status_code == 401


def test_expired_token_rejected_coarse(api: TestClient):
    expired = _mint_token(ADMIN_EMAIL, "admin", expires_minutes=-5)
    response = api.get("/ui/overview", headers={"Authorization": f"Bearer {expired}"})
    assert response.status_code == 401


def test_garbage_bearer_token_rejected(api: TestClient):
    response = api.get(
        "/ui/overview", headers={"Authorization": "Bearer not-a-jwt"}
    )
    assert response.status_code == 401


def test_query_token_rejected_on_normal_routes(api: TestClient, session_factory):
    """?token= is an EventSource-only seam; normal routes demand the header."""
    _insert_viewer(session_factory)
    token = _mint_token(VIEWER_EMAIL, "viewer")
    overview = api.get(f"/ui/overview?token={token}")
    assert overview.status_code == 401
    events = api.get(f"/runs/does-not-exist/events?token={token}")
    assert events.status_code == 401


@pytest.mark.parametrize(
    "path",
    ["/ui/runs/does-not-exist/stream", "/api/datasets/stream"],
)
def test_query_token_accepted_only_on_sse_stream_routes(
    api: TestClient, session_factory, path: str
):
    """Native EventSource cannot send headers: GET SSE routes accept ?token=."""
    _insert_viewer(session_factory)
    token = _mint_token(VIEWER_EMAIL, "viewer")
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "query_string": f"token={token}".encode(),
            "headers": [],
        }
    )

    user = auth_dependencies.get_current_user(request, credentials=None)

    assert user is not None
    assert user.email == VIEWER_EMAIL


def test_sse_query_route_matcher_matrix():
    from src.api.auth.dependencies import _accepts_query_token

    assert _accepts_query_token("GET", "/api/datasets/stream")
    assert _accepts_query_token("GET", "/ui/runs/abc-123/stream")
    assert not _accepts_query_token("POST", "/ui/runs/abc-123/stream")
    assert not _accepts_query_token("GET", "/ui/runs/abc-123/stream/extra")
    assert not _accepts_query_token("GET", "/ui/runs/stream")
    assert not _accepts_query_token("GET", "/ui/overview")
    assert not _accepts_query_token("GET", "/health")
    assert not _accepts_query_token("GET", "/runs/x/events")


def test_bearer_header_wins_over_query_token_on_sse_route():
    """Precedence contract: an explicit Authorization header always beats ?token=."""
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/ui/runs/r1/stream",
            "query_string": b"token=query-jwt",
            "headers": [(b"authorization", b"Bearer header-jwt")],
        }
    )
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="header-jwt")

    assert auth_dependencies._extract_token(request, credentials) == "header-jwt"


def test_tampered_header_beats_valid_query_token_on_sse_route(
    api: TestClient, session_factory
):
    """Header wins even when wrong: a valid ?token= cannot rescue a bad Bearer header."""
    _insert_viewer(session_factory)
    token = _mint_token(VIEWER_EMAIL, "viewer")
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/ui/runs/r1/stream",
            "query_string": f"token={token}".encode(),
            "headers": [],
        }
    )
    bad_credentials = HTTPAuthorizationCredentials(
        scheme="Bearer", credentials="not-a-jwt"
    )

    with pytest.raises(HTTPException) as excinfo:
        auth_dependencies.get_current_user(request, credentials=bad_credentials)

    assert excinfo.value.status_code == 401


def test_bootstrap_admin_idempotent_second_call_noop(api: TestClient):
    _bootstrap_admin(api)
    second = api.post(
        "/api/auth/bootstrap-admin",
        json={"email": "other@test.local", "password": "other-password-123"},
    )
    assert second.status_code == 200
    assert second.json() == {"created": False, "email": "other@test.local"}

    session = auth_router_module.get_session()
    try:
        assert session.query(UserRecord).count() == 1
    finally:
        session.close()


def test_require_role_factory_rejects_other_roles():
    checker = require_role("admin")
    viewer = UserRecord(id=1, email=VIEWER_EMAIL, role="viewer", is_active=True)
    admin = UserRecord(id=2, email=ADMIN_EMAIL, role="admin", is_active=True)

    with pytest.raises(HTTPException) as excinfo:
        checker(user=viewer)
    assert excinfo.value.status_code == 403

    assert checker(user=admin) is admin


def test_inactive_or_missing_user_token_rejected(api: TestClient, session_factory):
    _insert_viewer(session_factory)
    token = _mint_token("ghost@test.local", "viewer")
    assert (
        api.get("/ui/overview", headers={"Authorization": f"Bearer {token}"}).status_code
        == 401
    )

    session = session_factory()
    try:
        session.query(UserRecord).filter_by(email=VIEWER_EMAIL).update({"is_active": False})
        session.commit()
    finally:
        session.close()

    inactive = _mint_token(VIEWER_EMAIL, "viewer")
    response = api.get("/ui/overview", headers={"Authorization": f"Bearer {inactive}"})
    assert response.status_code == 401


def test_empty_secret_fails_fast_at_first_use(monkeypatch: pytest.MonkeyPatch):
    settings = Settings()
    monkeypatch.setattr(settings, "auth_jwt_secret", "")
    monkeypatch.setattr(auth_security, "_auth_settings", lambda: settings)
    with pytest.raises(ValueError, match="AUTH_JWT_SECRET"):
        auth_security.get_jwt_secret(settings)


def test_password_hash_roundtrip():
    hashed = auth_security.hash_password("s3cret-value")
    assert hashed != "s3cret-value"
    assert auth_security.verify_password("s3cret-value", hashed)
    assert not auth_security.verify_password("wrong", hashed)
    assert not auth_security.verify_password("anything", "")
