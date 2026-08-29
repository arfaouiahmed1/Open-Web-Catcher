"""T36 settings reliability contract tests.

Covers the enforced precedence chain ``default < env < base_yaml <
runtime_yaml``, the empty-string clobber fix, typed server-side PATCH
validation, ``{value, source_layer}`` reads, and a parametrized
set -> persist -> reload -> assert-effective round trip for EVERY field
declared on ``Settings.model_fields``.
"""

from __future__ import annotations

import os
import types
from pathlib import Path
from typing import Any, Union, get_args, get_origin

import pytest
import yaml

from src.utils.config import (
    DEFAULT_BASE_YAML_PATH,
    DEFAULT_DOTENV_PATH,
    DEFAULT_RUNTIME_YAML_PATH,
    SETTINGS_SOURCE_LAYERS,
    Settings,
    SettingsPatchError,
    is_blank_setting_value,
    persist_settings_patch,
    read_settings_with_sources,
    validate_settings_patch,
)

pytestmark = pytest.mark.unit

ALL_FIELDS = sorted(Settings.model_fields)

# from_yaml pins/derives these AFTER layering (ADR-003 Playwright-only rule),
# so their effective values do not equal the raw persisted key.
PINNED_VALUES = {"browser_engine": "playwright"}
DERIVED_FROM_FIELDS = {"mcp_server_url": "mcp_server_url_playwright"}


# --------------------------------------------------------------------------- #
# helpers / fixtures
# --------------------------------------------------------------------------- #
def _union_args(annotation: Any) -> Any:
    if get_origin(annotation) in (Union, types.UnionType):
        non_none = [arg for arg in get_args(annotation) if arg is not type(None)]
        if non_none:
            return non_none[0]
    return annotation


def _annotation_kind(annotation: Any) -> str:
    target = _union_args(annotation)
    origin = get_origin(target)
    if target is bool:
        return "bool"
    if target is int:
        return "int"
    if target is float:
        return "float"
    if target is str:
        return "str"
    if target is dict or origin is dict:
        return "dict"
    return "unknown"


def _sample_value(field_name: str) -> Any:
    """A valid probe value, different from the field default where possible."""
    info = Settings.model_fields[field_name]
    default = info.get_default(call_default_factory=True)
    kind = _annotation_kind(info.annotation)
    if kind == "bool":
        return not bool(default)
    if kind == "int":
        return 9
    if kind == "float":
        return 0.73
    if kind == "str":
        return f"t36-probe-{field_name}"[:80]
    if kind == "dict":
        return {"t36_probe": field_name}
    raise AssertionError(f"unhandled Settings annotation kind {kind!r} for {field_name!r}")


def test_every_settings_field_has_a_supported_probe_kind() -> None:
    unknown = [
        name
        for name in ALL_FIELDS
        if _annotation_kind(Settings.model_fields[name].annotation) == "unknown"
    ]
    assert unknown == [], f"add probe support for: {unknown}"


_ENV_CANDIDATES: set[str] = {
    choice.upper()
    for name, info in Settings.model_fields.items()
    for choice in ([name, str(getattr(info, "validation_alias", "") or "")])
    if choice
}


@pytest.fixture()
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """Isolated cwd/env/YAML layers so no host .env or env var leaks in."""
    monkeypatch.chdir(tmp_path)
    for var in list(os.environ):
        if var.upper() in _ENV_CANDIDATES:
            monkeypatch.delenv(var, raising=False)
    base = tmp_path / "settings.yaml"
    runtime = tmp_path / "settings.runtime.yaml"
    dotenv = tmp_path / ".env"
    for path in (base, runtime):
        path.write_text("", encoding="utf-8")
    return {
        "root": tmp_path,
        DEFAULT_BASE_YAML_PATH: base,
        DEFAULT_RUNTIME_YAML_PATH: runtime,
        DEFAULT_DOTENV_PATH: dotenv,
    }


def _write_yaml(path: Path, payload: dict) -> None:
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")


def _round_trip(field_name: str, sandbox: dict[str, Path]) -> tuple[Settings, dict]:
    sample = _sample_value(field_name)
    persist_settings_patch(
        {field_name: sample},
        base_yaml=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
    )
    reloaded = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH],
        sandbox[DEFAULT_RUNTIME_YAML_PATH],
    )
    sources = read_settings_with_sources(
        reloaded,
        yaml_path=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
        dotenv_path=sandbox[DEFAULT_DOTENV_PATH],
    )
    return reloaded, sources


@pytest.fixture()
def api_sandbox(sandbox: dict[str, Path], monkeypatch: pytest.MonkeyPatch):
    """Sandbox + the app module with get_settings bound to isolated settings."""
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )

    def _fake_get_settings(force_reload: bool = False) -> Settings:
        return settings

    from src.api import app as app_module

    monkeypatch.setattr(app_module, "get_settings", _fake_get_settings)
    return {"module": app_module, "settings": settings}


# --------------------------------------------------------------------------- #
# per-field round-trip contract: set -> persist -> reload -> assert-effective
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("field_name", ALL_FIELDS)
def test_field_round_trip_set_persist_reload_effective(
    field_name: str, sandbox: dict[str, Path]
) -> None:
    reloaded, sources = _round_trip(field_name, sandbox)
    sample = _sample_value(field_name)

    if field_name in PINNED_VALUES:
        expected = PINNED_VALUES[field_name]
    elif field_name in DERIVED_FROM_FIELDS:
        expected = getattr(reloaded, DERIVED_FROM_FIELDS[field_name])
    else:
        expected = sample

    assert getattr(reloaded, field_name) == expected

    entry = sources[field_name]
    assert set(entry) == {"value", "source_layer"}
    # The key was written to the strongest YAML layer, so provenance must say
    # runtime_yaml even when from_yaml post-pins the final value.
    assert entry["source_layer"] == "runtime_yaml"
    if field_name not in DERIVED_FROM_FIELDS:
        assert entry["value"] == expected


@pytest.mark.parametrize("field_name", ALL_FIELDS)
def test_read_settings_sources_shape(field_name: str, sandbox: dict[str, Path]) -> None:
    _, sources = _round_trip(field_name, sandbox)
    assert sorted(sources) == ALL_FIELDS
    for entry in sources.values():
        assert set(entry) == {"value", "source_layer"}
        assert entry["source_layer"] in SETTINGS_SOURCE_LAYERS


# --------------------------------------------------------------------------- #
# precedence chain enforcement: default < env < base_yaml < runtime_yaml
# --------------------------------------------------------------------------- #
def test_precedence_runtime_beats_base_beats_env_beats_default(
    sandbox: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOG_LEVEL", "ENV_LAYER_VALUE")
    _write_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH],
        {"log_level": "BASE_LAYER_VALUE", "memory_prompt_limit": 3},
    )
    _write_yaml(
        sandbox[DEFAULT_RUNTIME_YAML_PATH],
        {"log_level": "RUNTIME_LAYER_VALUE", "background_job_concurrency": 4},
    )
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    assert settings.log_level == "RUNTIME_LAYER_VALUE"
    assert settings.memory_prompt_limit == 3
    assert settings.background_job_concurrency == 4

    sources = read_settings_with_sources(
        settings,
        yaml_path=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
        dotenv_path=sandbox[DEFAULT_DOTENV_PATH],
    )
    assert sources["log_level"]["source_layer"] == "runtime_yaml"
    assert sources["memory_prompt_limit"]["source_layer"] == "base_yaml"


def test_precedence_env_layer_used_when_no_yaml_key(
    sandbox: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEMORY_PROMPT_LIMIT", "11")
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    assert settings.memory_prompt_limit == 11
    sources = read_settings_with_sources(
        settings,
        yaml_path=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
        dotenv_path=sandbox[DEFAULT_DOTENV_PATH],
    )
    assert sources["memory_prompt_limit"] == {"value": 11, "source_layer": "env"}


def test_dotenv_used_but_real_environment_wins(
    sandbox: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    sandbox[DEFAULT_DOTENV_PATH].write_text("MEMORY_PROMPT_LIMIT=5\n", encoding="utf-8")
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    assert settings.memory_prompt_limit == 5

    monkeypatch.setenv("MEMORY_PROMPT_LIMIT", "7")
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    assert settings.memory_prompt_limit == 7
    sources = read_settings_with_sources(
        settings,
        yaml_path=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
        dotenv_path=sandbox[DEFAULT_DOTENV_PATH],
    )
    assert sources["memory_prompt_limit"] == {"value": 7, "source_layer": "env"}


def test_defaults_reported_as_default_layer(sandbox: dict[str, Path]) -> None:
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    sources = read_settings_with_sources(
        settings,
        yaml_path=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
        dotenv_path=sandbox[DEFAULT_DOTENV_PATH],
    )
    assert sources["orchestrator_max_tool_calls"] == {
        "value": 60,
        "source_layer": "default",
    }


# --------------------------------------------------------------------------- #
# empty-string clobber fix: blank YAML values are treated as absent
# --------------------------------------------------------------------------- #
def test_empty_string_in_runtime_yaml_cannot_clobber_base(
    sandbox: dict[str, Path],
) -> None:
    _write_yaml(sandbox[DEFAULT_BASE_YAML_PATH], {"log_level": "BASE_LAYER_VALUE"})
    _write_yaml(sandbox[DEFAULT_RUNTIME_YAML_PATH], {"log_level": ""})
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    assert settings.log_level == "BASE_LAYER_VALUE"
    sources = read_settings_with_sources(
        settings,
        yaml_path=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
        dotenv_path=sandbox[DEFAULT_DOTENV_PATH],
    )
    assert sources["log_level"] == {"value": "BASE_LAYER_VALUE", "source_layer": "base_yaml"}


def test_empty_string_in_yaml_cannot_clobber_env(
    sandbox: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LOG_LEVEL", "ENV_LAYER_VALUE")
    _write_yaml(sandbox[DEFAULT_RUNTIME_YAML_PATH], {"log_level": "   "})
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    assert settings.log_level == "ENV_LAYER_VALUE"


def test_null_in_runtime_yaml_cannot_clobber_base(sandbox: dict[str, Path]) -> None:
    _write_yaml(sandbox[DEFAULT_BASE_YAML_PATH], {"gemini_temperature": 0.5})
    _write_yaml(sandbox[DEFAULT_RUNTIME_YAML_PATH], {"gemini_temperature": None})
    settings = Settings.from_yaml(
        sandbox[DEFAULT_BASE_YAML_PATH], sandbox[DEFAULT_RUNTIME_YAML_PATH]
    )
    assert settings.gemini_temperature == 0.5


def test_is_blank_setting_value_matrix() -> None:
    assert is_blank_setting_value("")
    assert is_blank_setting_value("   ")
    assert is_blank_setting_value(None)
    assert not is_blank_setting_value("x")
    assert not is_blank_setting_value(0)
    assert not is_blank_setting_value(False)


def test_persist_never_writes_blank_values(sandbox: dict[str, Path]) -> None:
    target = persist_settings_patch(
        {"log_level": "", "agent_model": "probe-model"},
        base_yaml=sandbox[DEFAULT_BASE_YAML_PATH],
        runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
    )
    on_disk = yaml.safe_load(target.read_text(encoding="utf-8"))
    assert "log_level" not in on_disk
    assert on_disk["agent_model"] == "probe-model"


# --------------------------------------------------------------------------- #
# typed server-side PATCH validation
# --------------------------------------------------------------------------- #
def test_validate_patch_coerces_known_fields() -> None:
    validated = validate_settings_patch(
        {
            "gemini_temperature": "0.42",
            "max_parallel_hosting_pages": "7",
            "thinking_enabled": "true",
            "agent_model": None,  # None == not provided -> dropped
        }
    )
    assert validated == {
        "gemini_temperature": 0.42,
        "max_parallel_hosting_pages": 7,
        "thinking_enabled": True,
    }


def test_validate_patch_rejects_unknown_fields_and_reports_all_errors() -> None:
    with pytest.raises(SettingsPatchError) as excinfo:
        validate_settings_patch(
            {
                "not_a_settings_field": 1,
                "gemini_temperature": "definitely-not-a-number",
                "orchestrator_model": "ok-model",
            }
        )
    message = str(excinfo.value)
    assert "not_a_settings_field" in message
    assert "gemini_temperature" in message
    assert excinfo.value.errors  # aggregated, not fail-first


def test_validate_patch_rejects_non_mapping_payload() -> None:
    with pytest.raises(SettingsPatchError):
        validate_settings_patch(["log_level", "INFO"])  # type: ignore[arg-type]


def test_persist_patch_rejects_invalid_payload_before_touching_disk(
    sandbox: dict[str, Path],
) -> None:
    before = sandbox[DEFAULT_RUNTIME_YAML_PATH].read_text(encoding="utf-8")
    with pytest.raises(SettingsPatchError):
        persist_settings_patch(
            {"bogus_field": 1},
            base_yaml=sandbox[DEFAULT_BASE_YAML_PATH],
            runtime_yaml_path=sandbox[DEFAULT_RUNTIME_YAML_PATH],
        )
    assert sandbox[DEFAULT_RUNTIME_YAML_PATH].read_text(encoding="utf-8") == before


# --------------------------------------------------------------------------- #
# endpoint handlers: {value, source_layer} reads + typed PATCH guard
# --------------------------------------------------------------------------- #
def test_ui_get_config_exposes_settings_sources(api_sandbox: dict) -> None:
    payload = api_sandbox["module"].ui_get_config()
    sources = payload["settings_sources"]
    assert sorted(sources) == ALL_FIELDS
    entry = sources["agent_model"]
    assert set(entry) == {"value", "source_layer"}
    assert entry["source_layer"] in SETTINGS_SOURCE_LAYERS


def test_ui_update_config_validates_patch_server_side(
    api_sandbox: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    class _FakeBody:
        @staticmethod
        def model_dump(exclude_none: bool = True) -> dict:
            return {"not_a_settings_field": {"deeply": ["invalid"]}}

    with pytest.raises(HTTPException) as excinfo:
        api_sandbox["module"].ui_update_config(_FakeBody())
    assert excinfo.value.status_code == 422
    detail = excinfo.value.detail
    assert "not_a_settings_field" in "".join(detail["errors"])
