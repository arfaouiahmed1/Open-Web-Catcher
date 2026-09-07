"""WebAuthn passkey challenge and registration-option contracts."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.auth import dependencies as auth_dependencies
from src.api.auth import router as auth_router_module
from src.api.auth import security as auth_security
from src.storage.models import UserRecord
from src.utils.config import Settings

pytestmark = pytest.mark.unit

TEST_SECRET = "unit-test-secret-for-passkeys"
USER_EMAIL = "passkey-user@test.local"
USER_PASSWORD = "passkey-pass-123"


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
    monkeypatch.setattr(settings, "webauthn_rp_id", "localhost")
    monkeypatch.setattr(settings, "webauthn_origin", "http://localhost:3000")
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


def test_passkey_login_options_do_not_enumerate_unknown_user(api: TestClient) -> None:
    response = api.post("/api/auth/passkeys/login/options", json={"email": "unknown@test.local"})
    assert response.status_code == 200
    assert response.json() == {"available": False}


def test_passkey_login_options_without_registered_credential_is_unavailable(
    api: TestClient, session_factory
) -> None:
    _create_user(session_factory)
    response = api.post("/api/auth/passkeys/login/options", json={"email": USER_EMAIL})
    assert response.status_code == 200
    assert response.json() == {"available": False}


def test_passkey_registration_options_store_short_lived_challenge(
    api: TestClient, session_factory
) -> None:
    _create_user(session_factory)
    headers = _login(api)

    response = api.post("/api/auth/passkeys/register/options", headers=headers)
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["challenge_id"]) == 32
    assert payload["options"]["rp"]["id"] == "localhost"
    assert payload["options"]["user"]["name"] == USER_EMAIL
    assert payload["options"]["challenge"]

    session = session_factory()
    try:
        from src.storage.models import WebAuthnChallengeRecord

        challenge = (
            session.query(WebAuthnChallengeRecord)
            .filter(WebAuthnChallengeRecord.id == payload["challenge_id"])
            .one()
        )
        assert challenge.purpose == "registration"
        assert challenge.used is False
        assert challenge.expires_at is not None
    finally:
        session.close()


def test_passkey_registration_rejects_unknown_challenge(api: TestClient, session_factory) -> None:
    _create_user(session_factory)
    headers = _login(api)
    response = api.post(
        "/api/auth/passkeys/register/verify",
        headers=headers,
        json={"challenge_id": "x" * 32, "credential": {}},
    )
    assert response.status_code == 400
