"""Auth routes: login, current user, first-admin bootstrap (plan T3)."""

from __future__ import annotations

import hashlib
import json
import hmac
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from src.api.auth import security as auth_security
from src.api.auth.dependencies import get_current_user, user_payload
from src.storage.database import get_session
from src.storage.models import UserRecord, WebAuthnChallengeRecord, WebAuthnCredentialRecord

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=1024)


class BootstrapAdminRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=1024)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=8, max_length=1024)


@router.post("/login")
def login(body: LoginRequest) -> dict:
    session = get_session()
    try:
        user = session.query(UserRecord).filter(UserRecord.email == body.email).first()
        if (
            user is None
            or not user.is_active
            or not auth_security.verify_password(body.password, user.password_hash)
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            )
        if user.totp_enabled:
            challenge = auth_security.create_access_token(
                email=user.email,
                role=user.role,
                secret=auth_security.get_jwt_secret(),
                expires_minutes=5,
                purpose="2fa",
            )
            return {"requires_2fa": True, "challenge": challenge, "user": {"email": user.email}}
        token = auth_security.mint_access_token(user)
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": user_payload(user),
        }
    finally:
        session.close()


@router.get("/me")
def me(user: UserRecord = Depends(get_current_user)) -> dict:
    return {"user": user_payload(user)}


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    user: UserRecord = Depends(get_current_user),
) -> dict[str, bool]:
    """Change the authenticated user's password after verifying the old one."""
    if not auth_security.verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect"
        )
    if body.current_password == body.new_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="New password must be different"
        )

    session = get_session()
    try:
        stored_user = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if stored_user is None or not stored_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
            )
        stored_user.password_hash = auth_security.hash_password(body.new_password)
        session.commit()
        return {"updated": True}
    finally:
        session.close()


@router.post("/bootstrap-admin")
def bootstrap_admin(body: BootstrapAdminRequest) -> dict:
    """Create the first admin account; no-op success once any user exists.

    F-3 (security review): the claim is a single
    ``INSERT ... SELECT ... WHERE NOT EXISTS`` statement so concurrent
    different-email requests can create at most one admin while the table is
    empty — the previous count-then-insert sequence had a TOCTOU window.
    Identical semantics on SQLite and Postgres.
    """
    password_hash = auth_security.hash_password(body.password)
    session = get_session()
    try:
        result = cast(
            CursorResult,
            session.execute(
                text(
                    "INSERT INTO users (email, password_hash, role, is_active, created_at, password_reset_token_hash, password_reset_expires_at, email_verified, email_verification_token_hash, email_verification_expires_at, totp_secret, totp_enabled, totp_backup_codes) "
                    "SELECT :email, :password_hash, 'admin', TRUE, :created_at, '', NULL, FALSE, '', NULL, '', FALSE, '[]' "
                    "WHERE NOT EXISTS (SELECT 1 FROM users)"
                ),
                {
                    "email": body.email,
                    "password_hash": password_hash,
                    "created_at": datetime.now(timezone.utc),
                },
            ),
        )
        session.commit()
        return {"created": bool(result.rowcount), "email": body.email}
    finally:
        session.close()


logger = logging.getLogger(__name__)

RESET_TOKEN_TTL_MINUTES = 30


class PasswordResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=16, max_length=256)
    new_password: str = Field(min_length=8, max_length=1024)


def _hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post("/password-reset/request")
def request_password_reset(body: PasswordResetRequest) -> dict:
    """Issue a password-reset token; always succeeds to avoid enumeration."""
    session = get_session()
    try:
        email = body.email.strip().lower()
        user = session.query(UserRecord).filter(UserRecord.email.ilike(email)).first()
        if user is not None and user.is_active:
            token = secrets.token_urlsafe(32)
            user.password_reset_token_hash = _hash_reset_token(token)
            user.password_reset_expires_at = datetime.now(timezone.utc) + timedelta(
                minutes=RESET_TOKEN_TTL_MINUTES
            )
            session.commit()
            logger.info("Password reset requested for %s", email)
        return {"requested": True}
    finally:
        session.close()


@router.post("/password-reset/confirm")
def confirm_password_reset(body: PasswordResetConfirm) -> dict:
    """Redeem a reset token for a new password (single use, 30 min expiry)."""
    session = get_session()
    try:
        token_hash = _hash_reset_token(body.token.strip())
        candidates = (
            session.query(UserRecord)
            .filter(UserRecord.password_reset_token_hash == token_hash)
            .all()
        )
        user = next(
            (
                row
                for row in candidates
                if hmac.compare_digest(row.password_reset_token_hash or "", token_hash)
            ),
            None,
        )
        now = datetime.now(timezone.utc)
        expires_at = user.password_reset_expires_at if user is not None else None
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if user is None or not user.is_active or expires_at is None or expires_at <= now:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or expired reset token",
            )
        user.password_hash = auth_security.hash_password(body.new_password)
        user.password_reset_token_hash = ""
        user.password_reset_expires_at = None
        session.commit()
        return {"reset": True}
    finally:
        session.close()


EMAIL_VERIFICATION_TTL_HOURS = 24


class EmailVerificationConfirm(BaseModel):
    token: str = Field(min_length=16, max_length=256)


@router.post("/email/verify-request")
def request_email_verification(user: UserRecord = Depends(get_current_user)) -> dict:
    """Issue an email-verification token for the caller's own account."""
    from src.utils.mailer import send_email

    session = get_session()
    try:
        stored = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if stored is None or not stored.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
            )
        token = secrets.token_urlsafe(32)
        stored.email_verification_token_hash = _hash_reset_token(token)
        stored.email_verification_expires_at = datetime.now(timezone.utc) + timedelta(
            hours=EMAIL_VERIFICATION_TTL_HOURS
        )
        session.commit()
        settings = auth_security._auth_settings()
        delivered = send_email(
            settings,
            to=stored.email,
            subject="Verify your OWC operator email",
            body=(
                f"Confirm your Open Web Catcher operator email with this token "
                f"(expires in {EMAIL_VERIFICATION_TTL_HOURS} hours):\n\n{token}\n"
            ),
        )
        if not delivered:
            logger.info("Email verification requested for %s (SMTP not configured)", stored.email)
        return {"requested": True, "delivered": delivered}
    finally:
        session.close()


@router.post("/email/verify-confirm")
def confirm_email_verification(body: EmailVerificationConfirm) -> dict:
    """Redeem a verification token; the token itself is the credential."""
    session = get_session()
    try:
        token_hash = _hash_reset_token(body.token.strip())
        candidates = (
            session.query(UserRecord)
            .filter(UserRecord.email_verification_token_hash == token_hash)
            .all()
        )
        user = next(
            (
                row
                for row in candidates
                if hmac.compare_digest(row.email_verification_token_hash or "", token_hash)
            ),
            None,
        )
        now = datetime.now(timezone.utc)
        expires_at = user.email_verification_expires_at if user is not None else None
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if user is None or not user.is_active or expires_at is None or expires_at <= now:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or expired verification token",
            )
        user.email_verified = True
        user.email_verification_token_hash = ""
        user.email_verification_expires_at = None
        session.commit()
        return {"verified": True}
    finally:
        session.close()


@router.get("/email/status")
def email_verification_status(user: UserRecord = Depends(get_current_user)) -> dict:
    """Report the caller's own email-verification state (no secrets)."""
    return {"email": user.email, "email_verified": bool(user.email_verified)}


TOTP_ISSUER = "OWC"
TOTP_BACKUP_CODE_COUNT = 10
TOTP_RATE_LIMIT_ATTEMPTS = 5
TOTP_RATE_LIMIT_WINDOW_SECONDS = 300

_totp_failures: dict[str, list[float]] = {}


class TotpConfirm(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class TotpChallenge(BaseModel):
    challenge: str = Field(min_length=16, max_length=2048)
    code: str = Field(min_length=6, max_length=64)


class TotpDisable(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


def _totp_rate_limited(email: str) -> bool:
    import time as _time

    now = _time.monotonic()
    attempts = [
        ts for ts in _totp_failures.get(email, []) if now - ts < TOTP_RATE_LIMIT_WINDOW_SECONDS
    ]
    _totp_failures[email] = attempts
    return len(attempts) >= TOTP_RATE_LIMIT_ATTEMPTS


def _totp_record_failure(email: str) -> None:
    import time as _time

    _totp_failures.setdefault(email, []).append(_time.monotonic())


def _read_backup_codes(user: UserRecord) -> list[str]:
    import json as _json

    try:
        codes = _json.loads(user.totp_backup_codes or "[]")
    except ValueError:
        return []
    return [str(item) for item in codes] if isinstance(codes, list) else []


@router.post("/2fa/enroll")
def enroll_totp(user: UserRecord = Depends(get_current_user)) -> dict:
    """Generate a TOTP secret for the caller; enabled only after confirm."""
    import pyotp

    from src.utils.security_crypto import encrypt_secret

    session = get_session()
    try:
        stored = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if stored is None or not stored.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
            )
        secret = pyotp.random_base32()
        stored.totp_secret = encrypt_secret(secret)
        stored.totp_enabled = False
        session.commit()
        uri = pyotp.totp.TOTP(secret).provisioning_uri(name=stored.email, issuer_name=TOTP_ISSUER)
        return {"secret": secret, "otpauth_url": uri}
    finally:
        session.close()


@router.post("/2fa/confirm")
def confirm_totp(body: TotpConfirm, user: UserRecord = Depends(get_current_user)) -> dict:
    """Verify a TOTP code against the enrolled secret and enable 2FA."""
    import json as _json

    import pyotp

    from src.utils.security_crypto import decrypt_secret

    session = get_session()
    try:
        stored = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if stored is None or not stored.is_active or not stored.totp_secret:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="No TOTP enrollment pending"
            )
        secret = decrypt_secret(stored.totp_secret)
        if not pyotp.TOTP(secret).verify(body.code.strip(), valid_window=1):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authenticator code"
            )
        codes = [
            f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(TOTP_BACKUP_CODE_COUNT)
        ]
        stored.totp_backup_codes = _json.dumps(
            [auth_security.hash_password(code) for code in codes]
        )
        stored.totp_enabled = True
        session.commit()
        return {"enabled": True, "backup_codes": codes}
    finally:
        session.close()


@router.post("/2fa/disable")
def disable_totp(body: TotpDisable, user: UserRecord = Depends(get_current_user)) -> dict:
    """Disable 2FA after re-authenticating with the account password."""
    session = get_session()
    try:
        stored = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if (
            stored is None
            or not stored.is_active
            or not auth_security.verify_password(body.password, stored.password_hash)
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
            )
        stored.totp_secret = ""
        stored.totp_enabled = False
        stored.totp_backup_codes = "[]"
        session.commit()
        return {"disabled": True}
    finally:
        session.close()


@router.get("/2fa/status")
def totp_status(user: UserRecord = Depends(get_current_user)) -> dict[str, bool]:
    """Return whether the caller has TOTP enabled without revealing secrets."""
    return {"enabled": bool(user.totp_enabled)}


@router.post("/2fa/challenge")
def verify_totp_challenge(body: TotpChallenge) -> dict:
    """Redeem a short-lived 2FA challenge plus TOTP/backup code for a token."""
    import pyotp

    from src.utils.security_crypto import decrypt_secret

    try:
        payload = auth_security.decode_token(body.challenge, auth_security.get_jwt_secret())
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired challenge"
        ) from exc
    if payload.get("purpose") != "2fa" or not payload.get("sub"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired challenge"
        )
    email = str(payload["sub"])
    if _totp_rate_limited(email):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts; try again later",
        )
    session = get_session()
    try:
        stored = session.query(UserRecord).filter(UserRecord.email == email).first()
        if stored is None or not stored.is_active or not stored.totp_enabled:
            _totp_record_failure(email)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authenticator code"
            )
        code = body.code.strip()
        secret = decrypt_secret(stored.totp_secret) if stored.totp_secret else ""
        totp_ok = bool(secret) and pyotp.TOTP(secret).verify(code, valid_window=1)
        if not totp_ok:
            import json as _json

            remaining: list[str] = []
            matched = False
            for hashed in _read_backup_codes(stored):
                if not matched and auth_security.verify_password(code, hashed):
                    matched = True
                    continue
                remaining.append(hashed)
            if matched:
                stored.totp_backup_codes = _json.dumps(remaining)
                session.commit()
            else:
                _totp_record_failure(email)
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authenticator code"
                )
        token = auth_security.mint_access_token(stored)
        return {"access_token": token, "token_type": "bearer", "user": user_payload(stored)}
    finally:
        session.close()


class PasskeyRegisterVerify(BaseModel):
    challenge_id: str = Field(min_length=16, max_length=64)
    credential: dict[str, Any]


class PasskeyLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)


class PasskeyLoginVerify(BaseModel):
    challenge_id: str = Field(min_length=16, max_length=64)
    credential: dict[str, Any]


def _webauthn_settings() -> tuple[str, str]:
    settings = auth_security._auth_settings()
    return settings.webauthn_rp_id.strip(), settings.webauthn_origin.strip()


def _options_json(options: Any) -> dict[str, Any]:
    from webauthn import options_to_json

    return json.loads(options_to_json(options))


@router.get("/passkeys/status")
def passkey_status(user: UserRecord = Depends(get_current_user)) -> dict[str, int]:
    """Return the number of passkeys registered to the caller."""
    session = get_session()
    try:
        count = (
            session.query(WebAuthnCredentialRecord)
            .filter(WebAuthnCredentialRecord.user_id == user.id)
            .count()
        )
        return {"count": count}
    finally:
        session.close()


@router.post("/passkeys/register/options")
def passkey_register_options(user: UserRecord = Depends(get_current_user)) -> dict[str, Any]:
    """Create a registration challenge for the authenticated operator."""
    from webauthn import generate_registration_options
    from webauthn.helpers import bytes_to_base64url
    from webauthn.helpers.structs import (
        AuthenticatorSelectionCriteria,
        UserVerificationRequirement,
    )

    rp_id, _ = _webauthn_settings()
    session = get_session()
    try:
        stored = session.query(UserRecord).filter(UserRecord.email == user.email).first()
        if stored is None or not stored.is_active:
            raise HTTPException(status_code=401, detail="Not authenticated")
        challenge = secrets.token_bytes(32)
        challenge_id = uuid.uuid4().hex
        options = generate_registration_options(
            rp_id=rp_id,
            rp_name=TOTP_ISSUER,
            user_name=stored.email,
            user_display_name=stored.email,
            user_id=str(stored.id).encode("utf-8"),
            challenge=challenge,
            authenticator_selection=AuthenticatorSelectionCriteria(
                user_verification=UserVerificationRequirement.REQUIRED
            ),
        )
        session.add(
            WebAuthnChallengeRecord(
                id=challenge_id,
                user_id=stored.id,
                email=stored.email,
                purpose="registration",
                challenge=bytes_to_base64url(challenge),
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            )
        )
        session.commit()
        return {"challenge_id": challenge_id, "options": _options_json(options)}
    finally:
        session.close()


@router.post("/passkeys/register/verify")
def passkey_register_verify(
    body: PasskeyRegisterVerify,
    user: UserRecord = Depends(get_current_user),
) -> dict[str, Any]:
    """Verify and store one WebAuthn credential for the authenticated user."""
    from webauthn import verify_registration_response
    from webauthn.helpers import base64url_to_bytes, bytes_to_base64url

    rp_id, origin = _webauthn_settings()
    session = get_session()
    try:
        challenge = (
            session.query(WebAuthnChallengeRecord)
            .filter(
                WebAuthnChallengeRecord.id == body.challenge_id,
                WebAuthnChallengeRecord.user_id == user.id,
                WebAuthnChallengeRecord.purpose == "registration",
                WebAuthnChallengeRecord.used.is_(False),
            )
            .first()
        )
        now = datetime.now(timezone.utc)
        if challenge is None or challenge.expires_at <= now:
            raise HTTPException(status_code=400, detail="Invalid or expired passkey challenge")
        verification = verify_registration_response(
            credential=body.credential,
            expected_challenge=base64url_to_bytes(challenge.challenge),
            expected_rp_id=rp_id,
            expected_origin=origin,
            require_user_verification=True,
        )
        credential_id = bytes_to_base64url(verification.credential_id)
        exists = (
            session.query(WebAuthnCredentialRecord)
            .filter(WebAuthnCredentialRecord.credential_id == credential_id)
            .first()
        )
        if exists is not None:
            raise HTTPException(status_code=409, detail="Passkey is already registered")
        session.add(
            WebAuthnCredentialRecord(
                user_id=user.id,
                credential_id=credential_id,
                public_key=bytes_to_base64url(verification.credential_public_key),
                sign_count=verification.sign_count,
                transports=[],
            )
        )
        challenge.used = True
        session.commit()
        return {"registered": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid passkey registration") from exc
    finally:
        session.close()


@router.post("/passkeys/login/options")
def passkey_login_options(body: PasskeyLoginRequest) -> dict[str, Any]:
    """Create a login challenge; unknown emails receive a generic unavailable response."""
    from webauthn import generate_authentication_options
    from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
    from webauthn.helpers.structs import (
        PublicKeyCredentialDescriptor,
        UserVerificationRequirement,
    )

    rp_id, _ = _webauthn_settings()
    session = get_session()
    try:
        email = body.email.strip().lower()
        user = session.query(UserRecord).filter(UserRecord.email.ilike(email)).first()
        credentials = []
        if user is not None and user.is_active:
            credentials = (
                session.query(WebAuthnCredentialRecord)
                .filter(WebAuthnCredentialRecord.user_id == user.id)
                .all()
            )
        if not credentials:
            return {"available": False}
        challenge = secrets.token_bytes(32)
        challenge_id = uuid.uuid4().hex
        options = generate_authentication_options(
            rp_id=rp_id,
            challenge=challenge,
            allow_credentials=[
                PublicKeyCredentialDescriptor(id=base64url_to_bytes(item.credential_id))
                for item in credentials
            ],
            user_verification=UserVerificationRequirement.REQUIRED,
        )
        session.add(
            WebAuthnChallengeRecord(
                id=challenge_id,
                user_id=user.id,
                email=user.email,
                purpose="authentication",
                challenge=bytes_to_base64url(challenge),
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            )
        )
        session.commit()
        return {"available": True, "challenge_id": challenge_id, "options": _options_json(options)}
    finally:
        session.close()


@router.post("/passkeys/login/verify")
def passkey_login_verify(body: PasskeyLoginVerify) -> dict[str, Any]:
    """Verify a WebAuthn assertion and issue the normal bearer token."""
    from webauthn import verify_authentication_response
    from webauthn.helpers import base64url_to_bytes

    rp_id, origin = _webauthn_settings()
    credential_id = str(body.credential.get("rawId") or body.credential.get("id") or "")
    session = get_session()
    try:
        challenge = (
            session.query(WebAuthnChallengeRecord)
            .filter(
                WebAuthnChallengeRecord.id == body.challenge_id,
                WebAuthnChallengeRecord.purpose == "authentication",
                WebAuthnChallengeRecord.used.is_(False),
            )
            .first()
        )
        now = datetime.now(timezone.utc)
        credential = (
            session.query(WebAuthnCredentialRecord)
            .filter(WebAuthnCredentialRecord.credential_id == credential_id)
            .first()
        )
        if challenge is None or challenge.expires_at <= now or credential is None:
            raise HTTPException(status_code=401, detail="Invalid or expired passkey challenge")
        user = (
            session.query(UserRecord)
            .filter(UserRecord.id == credential.user_id, UserRecord.is_active.is_(True))
            .first()
        )
        if user is None:
            raise HTTPException(status_code=401, detail="Invalid passkey")
        verification = verify_authentication_response(
            credential=body.credential,
            expected_challenge=base64url_to_bytes(challenge.challenge),
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=base64url_to_bytes(credential.public_key),
            credential_current_sign_count=credential.sign_count,
            require_user_verification=True,
        )
        credential.sign_count = verification.new_sign_count
        challenge.used = True
        session.commit()
        return {
            "access_token": auth_security.mint_access_token(user),
            "token_type": "bearer",
            "user": user_payload(user),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid passkey assertion") from exc
    finally:
        session.close()
