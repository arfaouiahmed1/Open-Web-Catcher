"""Password-reset request/confirm contract: enumeration-safe, single-use, expiring."""

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

TEST_SECRET = "unit-test-secret-for-password-reset"
USER_EMAIL = "reset-user@test.local"
USER_PASSWORD = "original-pass-123"


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


def _create_user(session_factory, email: str = USER_EMAIL) -> None:
    session = session_factory()
    try:
        session.add(
            UserRecord(
                email=email,
                password_hash=auth_security.hash_password(USER_PASSWORD),
                role="viewer",
                is_active=True,
            )
        )
        session.commit()
    finally:
        session.close()


def test_request_unknown_email_returns_success_without_side_effect(
    api: TestClient, session_factory
) -> None:
    response = api.post("/api/auth/password-reset/request", json={"email": "nobody@test.local"})
    assert response.status_code == 200
    assert response.json() == {"requested": True}

    session = session_factory()
    try:
        assert session.query(UserRecord).count() == 0
    finally:
        session.close()


def test_request_known_email_stores_hash_and_expiry(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    response = api.post("/api/auth/password-reset/request", json={"email": USER_EMAIL})
    assert response.status_code == 200

    session = session_factory()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == USER_EMAIL).first()
        assert user is not None
        assert user.password_reset_token_hash
        assert len(user.password_reset_token_hash) == 64
        assert user.password_reset_expires_at is not None
    finally:
        session.close()


def test_confirm_invalid_token_rejected(api: TestClient) -> None:
    response = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": "a" * 32, "new_password": "brand-new-pass-123"},
    )
    assert response.status_code == 400


def test_confirm_valid_token_resets_password_and_is_single_use(
    api: TestClient, session_factory
) -> None:
    _create_user(session_factory)
    assert (
        api.post("/api/auth/password-reset/request", json={"email": USER_EMAIL}).status_code == 200
    )

    # Recover the raw token path is unknowable; seed a known token hash directly.
    known_token = "k" * 32
    session = session_factory()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == USER_EMAIL).first()
        assert user is not None
        user.password_reset_token_hash = _hash_reset_token(known_token)
        user.password_reset_expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
        session.commit()
    finally:
        session.close()

    response = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": known_token, "new_password": "brand-new-pass-123"},
    )
    assert response.status_code == 200
    assert response.json() == {"reset": True}

    login = api.post(
        "/api/auth/login", json={"email": USER_EMAIL, "password": "brand-new-pass-123"}
    )
    assert login.status_code == 200

    reuse = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": known_token, "new_password": "another-pass-123"},
    )
    assert reuse.status_code == 400


def test_confirm_expired_token_rejected(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    known_token = "e" * 32
    session = session_factory()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == USER_EMAIL).first()
        assert user is not None
        user.password_reset_token_hash = _hash_reset_token(known_token)
        user.password_reset_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        session.commit()
    finally:
        session.close()

    response = api.post(
        "/api/auth/password-reset/confirm",
        json={"token": known_token, "new_password": "brand-new-pass-123"},
    )
    assert response.status_code == 400
