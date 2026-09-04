"""Phase 1 settings toggle persistence contract.

Verifies that a full settings PATCH with every model/caching/thinking,
browser-runtime, retention, and BYOK toggle inverted persists to disk and
reads back identically through the default precedence chain, and that every
operator-editable browser runtime knob survives a JSON round-trip through
``normalize_browser_runtime``.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import pytest
import yaml

from src.api.provider_config import (
    ModelConfigRequest,
    apply_ui_config_update,
)
from src.utils.browser_runtime import normalize_browser_runtime
from src.utils.config import Settings

pytestmark = pytest.mark.unit

_ENV_CANDIDATES: set[str] = {
    choice.upper()
    for name, info in Settings.model_fields.items()
    for choice in ([name, str(getattr(info, "validation_alias", "") or "")])
    if choice
}

FULL_PATCH: dict[str, Any] = {
    "llm_provider": "openai",
    "agent_model": "gpt-4o-mini",
    "orchestrator_model": "gpt-4o",
    "gemini_temperature": 1.0,
    "llm_tuning": {
        "provider_defaults": {"openai": {"temperature": 0.5}},
        "model_overrides": {"openai::gpt-4o-mini": {"temperature": 0.3}},
        "agent_overrides": {"hosting": {"temperature": 0.9}},
    },
    "agent_model_config": {
        "classification": {"provider": "openai", "model": "gpt-4o-mini"},
        "landing": {"provider": "openai", "model": "gpt-4o-mini"},
        "hosting": {"provider": "groq", "model": "llama-3.3-70b-versatile"},
        "embedded": {"provider": "mistral", "model": "mistral-large-latest"},
        "orchestrator": {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    },
    "provider_cache_enabled": False,
    "gemini_explicit_cache_enabled": False,
    "gemini_explicit_cache_ttl_seconds": 3600,
    "gemini_explicit_cache_refresh_lead_seconds": 300,
    "tool_result_cache_enabled": False,
    "tool_result_cache_min_identical_observations": 5,
    "thinking_enabled": True,
    "thinking_budget_tokens": 16000,
    "max_parallel_hosting_pages": 9,
    "browser_engine": "playwright",
    "browser_runtime": {
        "playwright": {
            "launch_timeout_ms": 60000,
            "extra_launch_args": ["--disable-dev-shm-usage"],
            "adblock_allowlist_hosts": ["example.com"],
            "streaming_safe_mode": "never",
            "asset_diagnostics_enabled": False,
            "popup_blocking_enabled": False,
            "ubol_enabled": False,
            "stream_cors_patch_enabled": True,
            "stream_cors_include_credentials": True,
            "iframe_sandbox_patch_enabled": False,
            "iframe_auto_recovery_enabled": False,
            "iframe_recovery_timeout_ms": 30000,
            "media_capture_timeout_ms": 60000,
            "media_cors_patch_enabled": True,
            "media_playback_verification_enabled": False,
        }
    },
    "observability_enabled": False,
    "background_job_retention_days": 45,
    "retention_days_runs": 45,
    "retention_days_run_snapshots": 44,
    "retention_days_llm_calls": 43,
    "retention_days_tool_calls": 42,
    "retention_days_agent_outputs": 41,
    "payload_cap_bytes": 16384,
    "workflow_max_cost_usd": 2.5,
    "workflow_max_tokens": 75000,
    "provider_api_keys": {"openai": "sk-test-openai", "groq": "gsk-test-groq"},
    "provider_base_urls": {"openai": "https://proxy.example.com/v1"},
}


@pytest.fixture()
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolated cwd/env/YAML layers so no host .env or env var leaks in."""
    monkeypatch.chdir(tmp_path)
    for var in list(os.environ):
        if var.upper() in _ENV_CANDIDATES:
            monkeypatch.delenv(var, raising=False)
    (tmp_path / "configs").mkdir(parents=True, exist_ok=True)
    (tmp_path / "data").mkdir(parents=True, exist_ok=True)
    (tmp_path / "configs" / "settings.yaml").write_text("", encoding="utf-8")
    (tmp_path / "data" / "settings.runtime.yaml").write_text("", encoding="utf-8")
    return tmp_path


def _apply_full_patch(settings: Settings) -> dict[str, Any]:
    return apply_ui_config_update(
        settings,
        ModelConfigRequest(**FULL_PATCH),
        reset_settings_cache=lambda: None,
        sync_provider_pricing=lambda _settings, _provider: {"provider": _provider, "skipped": True},
        logger=logging.getLogger("test-settings-toggle-persistence"),
    )


def test_full_toggle_patch_persists_and_reads_back_identically(sandbox: Path) -> None:
    settings = Settings.from_yaml()
    payload = _apply_full_patch(settings)

    assert payload["config_persisted"] is True

    reloaded = Settings.from_yaml()

    assert reloaded.llm_provider == "openai"
    assert reloaded.agent_model == "gpt-4o-mini"
    # agent_model_config routing wins over the flat fields by design.
    assert reloaded.orchestrator_model == "claude-sonnet-4-5"
    assert reloaded.provider_cache_enabled is False
    assert reloaded.gemini_explicit_cache_enabled is False
    assert reloaded.gemini_explicit_cache_ttl_seconds == 3600
    assert reloaded.gemini_explicit_cache_refresh_lead_seconds == 300
    assert reloaded.tool_result_cache_enabled is False
    assert reloaded.tool_result_cache_min_identical_observations == 5
    assert reloaded.thinking_enabled is True
    assert reloaded.thinking_budget_tokens == 16000
    assert reloaded.max_parallel_hosting_pages == 9
    assert reloaded.browser_engine == "playwright"
    assert reloaded.observability_enabled is False
    assert reloaded.background_job_retention_days == 45
    assert reloaded.retention_days_runs == 45
    assert reloaded.retention_days_run_snapshots == 44
    assert reloaded.retention_days_llm_calls == 43
    assert reloaded.retention_days_tool_calls == 42
    assert reloaded.retention_days_agent_outputs == 41
    assert reloaded.payload_cap_bytes == 16384
    assert reloaded.workflow_max_cost_usd == pytest.approx(2.5)
    assert reloaded.workflow_max_tokens == 75000

    # Per-agent routing survives normalization unchanged.
    for agent_id, selection in FULL_PATCH["agent_model_config"].items():
        assert reloaded.agent_model_config[agent_id] == selection

    # Tuning maps survive normalization unchanged.
    assert reloaded.llm_tuning["provider_defaults"] == {"openai": {"temperature": 0.5}}
    assert reloaded.llm_tuning["model_overrides"] == {"openai::gpt-4o-mini": {"temperature": 0.3}}
    assert reloaded.llm_tuning["agent_overrides"] == {"hosting": {"temperature": 0.9}}

    # Every browser runtime toggle survives the round-trip.
    expected_runtime = normalize_browser_runtime(FULL_PATCH["browser_runtime"])
    assert reloaded.browser_runtime == expected_runtime
    playwright = reloaded.browser_runtime["playwright"]
    assert playwright["ubol_enabled"] is False
    assert playwright["popup_blocking_enabled"] is False
    assert playwright["asset_diagnostics_enabled"] is False
    assert playwright["streaming_safe_mode"] == "never"
    assert playwright["stream_cors_patch_enabled"] is True
    assert playwright["stream_cors_include_credentials"] is True
    assert playwright["media_cors_patch_enabled"] is True
    assert playwright["media_playback_verification_enabled"] is False
    assert playwright["media_capture_timeout_ms"] == 60000
    assert playwright["iframe_auto_recovery_enabled"] is False
    assert playwright["iframe_sandbox_patch_enabled"] is False
    assert playwright["iframe_recovery_timeout_ms"] == 30000
    assert playwright["launch_timeout_ms"] == 60000
    assert playwright["extra_launch_args"] == ["--disable-dev-shm-usage"]
    assert playwright["adblock_allowlist_hosts"] == ["example.com"]

    # BYOK keys and base URLs persist without leaking secrets into the payload.
    assert reloaded.provider_api_keys["openai"] == "sk-test-openai"
    assert reloaded.provider_api_keys["groq"] == "gsk-test-groq"
    assert reloaded.provider_base_urls["openai"] == "https://proxy.example.com/v1"
    assert payload["api_keys"]["openai"] is True
    assert payload["api_keys"]["groq"] is True
    assert "sk-test-openai" not in json.dumps(payload)

    # The values actually landed on disk in one of the YAML layers.
    on_disk: dict[str, Any] = {}
    for candidate in ("configs/settings.yaml", "data/settings.runtime.yaml"):
        path = sandbox / candidate
        if path.exists():
            loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if isinstance(loaded, dict):
                on_disk.update(loaded)
    assert on_disk.get("max_parallel_hosting_pages") == 9
    assert on_disk.get("thinking_enabled") is True
    assert on_disk.get("provider_cache_enabled") is False


def test_browser_runtime_survives_json_round_trip() -> None:
    raw = FULL_PATCH["browser_runtime"]
    round_tripped = normalize_browser_runtime(json.loads(json.dumps(raw)))
    assert round_tripped == normalize_browser_runtime(raw)


def test_model_config_request_accepts_every_phase1_key() -> None:
    body = ModelConfigRequest(**FULL_PATCH)
    for key in (
        "llm_provider",
        "agent_model",
        "orchestrator_model",
        "gemini_temperature",
        "llm_tuning",
        "agent_model_config",
        "provider_cache_enabled",
        "gemini_explicit_cache_enabled",
        "gemini_explicit_cache_ttl_seconds",
        "gemini_explicit_cache_refresh_lead_seconds",
        "tool_result_cache_enabled",
        "tool_result_cache_min_identical_observations",
        "thinking_enabled",
        "thinking_budget_tokens",
        "max_parallel_hosting_pages",
        "browser_engine",
        "browser_runtime",
        "observability_enabled",
        "retention_days_runs",
        "payload_cap_bytes",
        "workflow_max_cost_usd",
        "provider_api_keys",
        "provider_base_urls",
    ):
        assert getattr(body, key) is not None, key
