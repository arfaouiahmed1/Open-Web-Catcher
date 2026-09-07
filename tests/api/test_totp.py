"""TOTP enrollment, login challenge, backup-code, and disable contracts."""

from __future__ import annotations

from collections.abc import Iterator

import pyotp
import pytest
from fastapi.testclient import TestClient

from src.api.auth import dependencies as auth_dependencies
from src.api.auth import router as auth_router_module
from src.api.auth import security as auth_security
from src.storage.models import UserRecord
from src.utils.config import Settings
from src.utils.security_crypto import ENCRYPTION_PREFIX

pytestmark = pytest.mark.unit

TEST_SECRET = "unit-test-secret-for-totp"
USER_EMAIL = "totp-user@test.local"
USER_PASSWORD = "totp-pass-123"


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


def _login(api: TestClient, password: str = USER_PASSWORD) -> dict:
    response = api.post("/api/auth/login", json={"email": USER_EMAIL, "password": password})
    assert response.status_code == 200, response.text
    return response.json()


def test_totp_enrollment_encrypts_secret_and_requires_confirmation(
    api: TestClient, session_factory
) -> None:
    _create_user(session_factory)
    initial = _login(api)
    headers = {"Authorization": f"Bearer {initial['access_token']}"}
    assert api.get("/api/auth/2fa/status", headers=headers).json() == {"enabled": False}

    enrollment = api.post("/api/auth/2fa/enroll", headers=headers)
    assert enrollment.status_code == 200
    body = enrollment.json()
    assert body["secret"]
    assert body["otpauth_url"].startswith("otpauth://totp/")

    session = session_factory()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == USER_EMAIL).first()
        assert user is not None
        assert user.totp_enabled is False
        assert user.totp_secret.startswith(ENCRYPTION_PREFIX)
        assert body["secret"] not in user.totp_secret
    finally:
        session.close()

    confirm = api.post(
        "/api/auth/2fa/confirm",
        headers=headers,
        json={"code": pyotp.TOTP(body["secret"]).now()},
    )
    assert confirm.status_code == 200
    backup_codes = confirm.json()["backup_codes"]
    assert len(backup_codes) == 10
    assert all(code not in user.totp_backup_codes for code in backup_codes)


def test_totp_login_returns_challenge_then_issues_token(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    initial = _login(api)
    headers = {"Authorization": f"Bearer {initial['access_token']}"}
    enrollment = api.post("/api/auth/2fa/enroll", headers=headers).json()
    assert (
        api.post(
            "/api/auth/2fa/confirm",
            headers=headers,
            json={"code": pyotp.TOTP(enrollment["secret"]).now()},
        ).status_code
        == 200
    )

    challenged = _login(api)
    assert challenged["requires_2fa"] is True
    assert challenged["challenge"]
    assert "access_token" not in challenged

    completed = api.post(
        "/api/auth/2fa/challenge",
        json={"challenge": challenged["challenge"], "code": pyotp.TOTP(enrollment["secret"]).now()},
    )
    assert completed.status_code == 200
    assert completed.json()["access_token"]


def test_totp_backup_code_is_single_use(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    initial = _login(api)
    headers = {"Authorization": f"Bearer {initial['access_token']}"}
    enrollment = api.post("/api/auth/2fa/enroll", headers=headers).json()
    backup = api.post(
        "/api/auth/2fa/confirm",
        headers=headers,
        json={"code": pyotp.TOTP(enrollment["secret"]).now()},
    ).json()["backup_codes"][0]
    challenged = _login(api)

    first = api.post(
        "/api/auth/2fa/challenge",
        json={"challenge": challenged["challenge"], "code": backup},
    )
    assert first.status_code == 200

    second = api.post(
        "/api/auth/2fa/challenge",
        json={"challenge": challenged["challenge"], "code": backup},
    )
    assert second.status_code == 401


def test_totp_disable_requires_password(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    initial = _login(api)
    headers = {"Authorization": f"Bearer {initial['access_token']}"}
    enrollment = api.post("/api/auth/2fa/enroll", headers=headers).json()
    assert (
        api.post(
            "/api/auth/2fa/confirm",
            headers=headers,
            json={"code": pyotp.TOTP(enrollment["secret"]).now()},
        ).status_code
        == 200
    )

    invalid = api.post(
        "/api/auth/2fa/disable", headers=headers, json={"password": "wrong-password"}
    )
    assert invalid.status_code == 401
    valid = api.post("/api/auth/2fa/disable", headers=headers, json={"password": USER_PASSWORD})
    assert valid.status_code == 200
    assert valid.json() == {"disabled": True}
