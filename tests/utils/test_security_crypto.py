"""Unit and integration tests for AES-256-GCM settings encryption at rest."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
import yaml  # type: ignore[import-untyped]

from src.utils.config import Settings, load_yaml_layer, persist_settings_patch
from src.utils.security_crypto import (
    ENCRYPTION_PREFIX,
    SECRET_SETTING_KEYS,
    SecretDecryptionError,
    decrypt_secret,
    decrypt_settings_layer,
    derive_encryption_key,
    encrypt_secret,
    encrypt_settings_layer,
    get_settings_encryption_key,
    is_encrypted_secret,
)

pytestmark = pytest.mark.unit


def test_aes_gcm_encrypt_decrypt_roundtrip() -> None:
    plaintext = "sk-live-secret-openai-api-key-9876543210"
    encrypted = encrypt_secret(plaintext)

    assert encrypted.startswith(ENCRYPTION_PREFIX)
    assert is_encrypted_secret(encrypted)
    assert plaintext not in encrypted

    decrypted = decrypt_secret(encrypted)
    assert decrypted == plaintext


def test_empty_or_none_secrets() -> None:
    assert encrypt_secret("") == ""
    assert encrypt_secret(None) == ""
    assert decrypt_secret("") == ""
    assert decrypt_secret(None) == ""


def test_idempotent_encryption() -> None:
    plaintext = "sk-live-secret-token"
    enc1 = encrypt_secret(plaintext)
    enc2 = encrypt_secret(enc1)
    assert enc1 == enc2
    assert decrypt_secret(enc2) == plaintext


def test_backward_compatibility_unencrypted_plaintext() -> None:
    legacy_key = "sk-legacy-unencrypted-key-abcdef"
    assert decrypt_secret(legacy_key) == legacy_key


def test_tampered_ciphertext_fails_closed() -> None:
    encrypted = encrypt_secret("my-super-secret-key")
    tampered = encrypted[:-4] + "AAAA"
    with pytest.raises(SecretDecryptionError):
        decrypt_secret(tampered)


def test_wrong_key_fails_closed() -> None:
    key_a = b"A" * 32
    key_b = b"B" * 32
    encrypted = encrypt_secret("my-secret-data", key=key_a)
    with pytest.raises(SecretDecryptionError, match="Failed to authenticate or decrypt"):
        decrypt_secret(encrypted, key=key_b)
def test_hkdf_key_derivation_deterministic() -> None:
    passphrase = "my-test-auth-jwt-secret-12345"
    key1 = derive_encryption_key(passphrase)
    key2 = derive_encryption_key(passphrase)
    key3 = derive_encryption_key("different-passphrase")

    assert len(key1) == 32
    assert key1 == key2
    assert key1 != key3


def test_key_precedence_env_vars(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    key_file = tmp_path / ".settings_key"

    # 1. SETTINGS_ENCRYPTION_KEY wins over others
    monkeypatch.setenv("SETTINGS_ENCRYPTION_KEY", "settings-key-val")
    monkeypatch.setenv("OWC_SECRET_KEY", "owc-secret-val")
    monkeypatch.setenv("AUTH_JWT_SECRET", "jwt-secret-val")
    k1 = get_settings_encryption_key(key_file)
    assert k1 == derive_encryption_key("settings-key-val")

    # 2. OWC_SECRET_KEY wins over AUTH_JWT_SECRET
    monkeypatch.delenv("SETTINGS_ENCRYPTION_KEY")
    k2 = get_settings_encryption_key(key_file)
    assert k2 == derive_encryption_key("owc-secret-val")

    # 3. AUTH_JWT_SECRET used when others absent
    monkeypatch.delenv("OWC_SECRET_KEY")
    k3 = get_settings_encryption_key(key_file)
    assert k3 == derive_encryption_key("jwt-secret-val")

    # 4. File fallback when no env vars set
    monkeypatch.delenv("AUTH_JWT_SECRET")
    k4 = get_settings_encryption_key(key_file)
    assert len(k4) == 32
    assert key_file.exists()
    # Reading again uses the persisted file key
    k4_reloaded = get_settings_encryption_key(key_file)
    assert k4_reloaded == k4


def test_encrypt_decrypt_settings_layer() -> None:
    layer: dict[str, Any] = {
        "llm_provider": "openai",
        "agent_model": "gpt-4o",
        "openai_api_key": "sk-secret-1",
        "google_api_key": "secret-2",
        "provider_api_keys": {
            "groq": "gsk-secret-3",
            "anthropic": "sk-ant-secret-4",
        },
        "prompt_cache_enabled": True,
    }

    encrypted_layer = encrypt_settings_layer(layer)
    assert encrypted_layer["llm_provider"] == "openai"
    assert encrypted_layer["agent_model"] == "gpt-4o"
    assert encrypted_layer["prompt_cache_enabled"] is True

    assert encrypted_layer["openai_api_key"].startswith(ENCRYPTION_PREFIX)
    assert encrypted_layer["google_api_key"].startswith(ENCRYPTION_PREFIX)
    assert encrypted_layer["provider_api_keys"]["groq"].startswith(ENCRYPTION_PREFIX)
    assert encrypted_layer["provider_api_keys"]["anthropic"].startswith(ENCRYPTION_PREFIX)

    decrypted_layer = decrypt_settings_layer(encrypted_layer)
    assert decrypted_layer == layer


def test_settings_save_and_load_encrypts_on_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    runtime_path = tmp_path / "data" / "settings.runtime.yaml"
    base_path = tmp_path / "configs" / "settings.yaml"
    base_path.parent.mkdir(parents=True, exist_ok=True)
    base_path.write_text("", encoding="utf-8")

    settings = Settings()
    settings.openai_api_key = "sk-super-secret-openai-key"
    settings.provider_api_keys = {"groq": "gsk-super-secret-groq-key"}

    # Save to disk
    saved_path = settings.save_yaml(yaml_path=base_path, runtime_yaml_path=runtime_path)
    assert saved_path == runtime_path

    # Read raw disk content
    raw_disk_text = runtime_path.read_text(encoding="utf-8")
    assert "sk-super-secret-openai-key" not in raw_disk_text
    assert "gsk-super-secret-groq-key" not in raw_disk_text
    assert ENCRYPTION_PREFIX in raw_disk_text

    raw_yaml = yaml.safe_load(raw_disk_text)
    assert raw_yaml["openai_api_key"].startswith(ENCRYPTION_PREFIX)
    assert raw_yaml["provider_api_keys"]["groq"].startswith(ENCRYPTION_PREFIX)

    # Reload through Settings.from_yaml and assert transparent decryption
    reloaded = Settings.from_yaml(yaml_path=base_path, runtime_yaml_path=runtime_path)
    assert reloaded.openai_api_key == "sk-super-secret-openai-key"
    assert reloaded.provider_api_keys["groq"] == "gsk-super-secret-groq-key"


def test_persist_settings_patch_encrypts_secrets(tmp_path: Path) -> None:
    runtime_path = tmp_path / "data" / "settings.runtime.yaml"

    patch = {
        "openai_api_key": "sk-patched-secret-key",
        "thinking_enabled": True,
    }

    persist_settings_patch(patch, runtime_yaml_path=runtime_path)

    raw_disk_text = runtime_path.read_text(encoding="utf-8")
    assert "sk-patched-secret-key" not in raw_disk_text
    assert ENCRYPTION_PREFIX in raw_disk_text

    raw_data = load_yaml_layer(runtime_path)
    assert raw_data["openai_api_key"].startswith(ENCRYPTION_PREFIX)
    assert raw_data["thinking_enabled"] is True
