"""Email verification request/confirm contract: hashed single-use tokens."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from src.api.auth import dependencies as auth_dependencies
from src.api.auth import router as auth_router_module
from src.api.auth import security as auth_security
from src.api.auth.router import _hash_reset_token
from src.storage.models import UserRecord
from src.utils.config import Settings

pytestmark = pytest.mark.unit

TEST_SECRET = "unit-test-secret-for-email-verify"
USER_EMAIL = "verify-user@test.local"
USER_PASSWORD = "verify-pass-123"


@pytest.fixture()
def api(monkeypatch: pytest.MonkeyPatch, session_factory) -> Iterator[TestClient]:
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


def _create_user(session_factory) -> None:
    session = session_factory()
    try:
        session.add(
            UserRecord(
                email=USER_EMAIL,
                password_hash=auth_security.hash_password(USER_PASSWORD),
                role="viewer",
                is_active=True,
            )
        )
        session.commit()
    finally:
        session.close()


def _login(api: TestClient) -> dict[str, str]:
    response = api.post("/api/auth/login", json={"email": USER_EMAIL, "password": USER_PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_verify_request_requires_auth(api: TestClient) -> None:
    response = api.post("/api/auth/email/verify-request")
    assert response.status_code == 401


def test_verify_request_stores_hash_and_expiry(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    headers = _login(api)
    response = api.post("/api/auth/email/verify-request", headers=headers)
    assert response.status_code == 200
    assert response.json()["requested"] is True

    session = session_factory()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == USER_EMAIL).first()
        assert user is not None
        assert len(user.email_verification_token_hash) == 64
        assert user.email_verification_expires_at is not None
        assert user.email_verified is False
    finally:
        session.close()


def test_verify_confirm_valid_token_marks_verified(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    headers = _login(api)
    assert api.post("/api/auth/email/verify-request", headers=headers).status_code == 200

    known_token = "v" * 32
    session = session_factory()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == USER_EMAIL).first()
        assert user is not None
        user.email_verification_token_hash = _hash_reset_token(known_token)
        user.email_verification_expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
        session.commit()
    finally:
        session.close()

    response = api.post("/api/auth/email/verify-confirm", json={"token": known_token})
    assert response.status_code == 200
    assert response.json() == {"verified": True}

    status = api.get("/api/auth/email/status", headers=headers)
    assert status.status_code == 200
    assert status.json() == {"email": USER_EMAIL, "email_verified": True}

    reuse = api.post("/api/auth/email/verify-confirm", json={"token": known_token})
    assert reuse.status_code == 400


def test_verify_confirm_invalid_and_expired_tokens_rejected(
    api: TestClient, session_factory
) -> None:
    _create_user(session_factory)

    bad = api.post("/api/auth/email/verify-confirm", json={"token": "z" * 32})
    assert bad.status_code == 400

    known_token = "x" * 32
    session = session_factory()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == USER_EMAIL).first()
        assert user is not None
        user.email_verification_token_hash = _hash_reset_token(known_token)
        user.email_verification_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        session.commit()
    finally:
        session.close()

    expired = api.post("/api/auth/email/verify-confirm", json={"token": known_token})
    assert expired.status_code == 400
