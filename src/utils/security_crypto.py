"""Cryptographic helpers for securing stored secrets and API keys at rest.

API keys and provider credentials stored locally in settings YAML files
are encrypted with authenticated AES-256-GCM. Unencrypted legacy values
are decrypted transparently on load and re-encrypted on save.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from src.utils.logging import get_logger

logger = get_logger(__name__)

ENCRYPTION_PREFIX = "enc:v1:aes-gcm:"
DEFAULT_KEY_FILE_PATH = Path("data") / ".settings_key"

SECRET_SETTING_KEYS: frozenset[str] = frozenset(
    {
        "google_api_key",
        "google_vertex_api_key",
        "openai_api_key",
        "anthropic_api_key",
        "openrouter_api_key",
        "nvidia_api_key",
        "mistral_api_key",
        "cohere_api_key",
        "groq_api_key",
        "together_api_key",
        "fireworks_api_key",
        "perplexity_api_key",
        "deepseek_api_key",
        "xai_api_key",
        "upstage_api_key",
        "azure_api_key",
        "bedrock_api_key",
        "cloudinary_api_key",
        "cloudinary_api_secret",
    }
)


class SecretDecryptionError(RuntimeError):
    """Raised when an encrypted secret cannot be authenticated or decrypted."""


def is_encrypted_secret(value: Any) -> bool:
    """Check if a string represents an encrypted secret payload."""
    return isinstance(value, str) and value.startswith("enc:")


def derive_encryption_key(secret: str | bytes) -> bytes:
    """Derive a 256-bit AES key from a passphrase using HKDF-SHA256."""
    secret_bytes = secret.encode("utf-8") if isinstance(secret, str) else secret
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"owc-settings-encryption-v1",
        info=b"settings-aes-gcm-key",
    ).derive(secret_bytes)


def get_settings_encryption_key(
    key_file_path: str | Path = DEFAULT_KEY_FILE_PATH,
) -> bytes:
    """Resolve the active AES-256 key for settings encryption.

    Order of precedence:
    1. Explicit ``SETTINGS_ENCRYPTION_KEY`` env var (raw 32-byte hex/base64 or string)
    2. ``OWC_SECRET_KEY`` env var (derived via HKDF)
    3. ``AUTH_JWT_SECRET`` env var (derived via HKDF)
    4. Local persistent key file in ``data/.settings_key``
    """
    for env_var in ("SETTINGS_ENCRYPTION_KEY", "OWC_SECRET_KEY", "AUTH_JWT_SECRET"):
        val = os.environ.get(env_var, "").strip()
        if val:
            # If 32-byte hex string provided directly
            if len(val) == 64:
                try:
                    return bytes.fromhex(val)
                except ValueError:
                    pass
            return derive_encryption_key(val)

    # Local file fallback for zero-config environments
    key_path = Path(key_file_path)
    if key_path.exists():
        try:
            raw = key_path.read_bytes().strip()
            if len(raw) == 32:
                return raw
            if len(raw) == 64:
                try:
                    return bytes.fromhex(raw.decode("ascii"))
                except ValueError:
                    pass
            return derive_encryption_key(raw)
        except OSError as exc:
            logger.warning("Could not read settings key file %s: %s", key_path, exc)

    # Generate and persist a new 32-byte random key
    new_key = os.urandom(32)
    try:
        key_path.parent.mkdir(parents=True, exist_ok=True)
        key_path.write_bytes(new_key)
        # Attempt to restrict file permissions on POSIX systems
        try:
            os.chmod(key_path, 0o600)
        except OSError:
            pass
    except OSError as exc:
        logger.warning("Could not persist settings key file %s: %s", key_path, exc)
    return new_key


def encrypt_secret(
    plaintext: str | None,
    key: bytes | None = None,
) -> str:
    """Encrypt a secret string using AES-256-GCM.

    Returns the formatted string ``enc:v1:aes-gcm:<base64-payload>``.
    If the string is already encrypted, it is returned unchanged.
    """
    if not plaintext:
        return ""
    if is_encrypted_secret(plaintext):
        return str(plaintext)

    active_key = key if key is not None else get_settings_encryption_key()
    aesgcm = AESGCM(active_key)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    encoded = base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")
    return f"{ENCRYPTION_PREFIX}{encoded}"


def decrypt_secret(
    value: str | None,
    key: bytes | None = None,
) -> str:
    """Decrypt an encrypted secret string using AES-256-GCM.

    If the value does not have the encrypted prefix, it is returned
    as-is to support unencrypted legacy configuration files.
    """
    if not value or not isinstance(value, str):
        return "" if value is None else str(value)
    if not is_encrypted_secret(value):
        return value
    if not value.startswith(ENCRYPTION_PREFIX):
        raise SecretDecryptionError(f"Unsupported encryption scheme for secret: {value[:20]}")

    payload_b64 = value[len(ENCRYPTION_PREFIX) :]
    try:
        raw = base64.urlsafe_b64decode(payload_b64)
        if len(raw) < 13:
            raise ValueError("Payload too short for nonce and ciphertext")
        nonce = raw[:12]
        ciphertext = raw[12:]
        active_key = key if key is not None else get_settings_encryption_key()
        aesgcm = AESGCM(active_key)
        plaintext_bytes = aesgcm.decrypt(nonce, ciphertext, None)
        return plaintext_bytes.decode("utf-8")
    except (InvalidTag, ValueError) as exc:
        raise SecretDecryptionError(
            f"Failed to authenticate or decrypt secret with active encryption key: {exc}"
        ) from exc


def encrypt_settings_layer(
    layer: dict[str, Any],
    key: bytes | None = None,
) -> dict[str, Any]:
    """Encrypt all secret fields in a dictionary before writing to disk."""
    out: dict[str, Any] = {}
    active_key = key if key is not None else get_settings_encryption_key()

    for k, v in layer.items():
        if k in SECRET_SETTING_KEYS and isinstance(v, str) and v.strip():
            out[k] = encrypt_secret(v, active_key)
        elif k == "provider_api_keys" and isinstance(v, dict):
            out[k] = {
                pk: encrypt_secret(pv, active_key) if isinstance(pv, str) and pv.strip() else pv
                for pk, pv in v.items()
            }
        else:
            out[k] = v
    return out


def decrypt_settings_layer(
    layer: dict[str, Any],
    key: bytes | None = None,
) -> dict[str, Any]:
    """Decrypt all secret fields in a dictionary after reading from disk."""
    out: dict[str, Any] = {}
    active_key = key if key is not None else get_settings_encryption_key()

    for k, v in layer.items():
        if k in SECRET_SETTING_KEYS and isinstance(v, str) and v.strip():
            out[k] = decrypt_secret(v, active_key)
        elif k == "provider_api_keys" and isinstance(v, dict):
            out[k] = {
                pk: decrypt_secret(pv, active_key) if isinstance(pv, str) and pv.strip() else pv
                for pk, pv in v.items()
            }
        else:
            out[k] = v
    return out
