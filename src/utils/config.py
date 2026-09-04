"""Application settings loaded from .env + settings.yaml.

Settings precedence contract (T36)
----------------------------------
Every settings value resolves through a single precedence chain, from
weakest to strongest layer:

    1. ``default``      -- typed defaults declared on the ``Settings`` model.
    2. ``env``          -- process environment variables, then a local
                           ``.env`` file (a real environment variable wins
                           over dotenv, matching pydantic-settings).
    3. ``base_yaml``    -- keys in ``configs/settings.yaml``.
    4. ``runtime_yaml`` -- keys in ``data/settings.runtime.yaml`` (where the
                           operator UI persists edits).

The chain is enforced in code: ``Settings.from_yaml`` layers base YAML under
runtime YAML on top of env, so a stronger layer always wins. Two rules keep
it reliable:

* Empty-string guard: blank values (``""``, whitespace-only, or ``null``)
  inside either YAML layer are treated as absent, so a stale empty key can
  never clobber a real value from a weaker layer.
* Provenance + validation at the edges: :func:`read_settings_with_sources`
  reports every field as ``{"value": ..., "source_layer": ...}``, PATCH
  payloads are validated against the typed ``Settings`` field models with
  :func:`validate_settings_patch` before anything mutates, and
  :func:`persist_settings_patch` writes validated patches into the runtime
  YAML layer.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from pydantic import AliasChoices, Field, TypeAdapter, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.utils.browser_runtime import normalize_browser_runtime

# Weakest -> strongest source layers for every settings value.
SETTINGS_SOURCE_LAYERS: tuple[str, ...] = ("default", "env", "base_yaml", "runtime_yaml")

DEFAULT_BASE_YAML_PATH = "configs/settings.yaml"
DEFAULT_RUNTIME_YAML_PATH = "data/settings.runtime.yaml"
DEFAULT_DOTENV_PATH = ".env"


def is_blank_setting_value(value: Any) -> bool:
    """True when a YAML/env value must be treated as absent (T36 clobber fix).

    Empty strings, whitespace-only strings and ``None`` carry no information;
    letting them through would let one stale key wipe out a weaker layer's
    real value.
    """
    return value is None or (isinstance(value, str) and not value.strip())


def load_yaml_layer(path: str | Path) -> dict:
    """Load one YAML settings layer; missing or invalid files yield {}."""
    candidate = Path(path)
    if not candidate.exists():
        return {}
    try:
        with open(candidate, encoding="utf-8") as f:
            loaded = yaml.safe_load(f) or {}
    except yaml.YAMLError:
        return {}
    return dict(loaded) if isinstance(loaded, dict) else {}


def load_settings_layers(
    yaml_path: str | Path = DEFAULT_BASE_YAML_PATH,
    runtime_yaml_path: str | Path = DEFAULT_RUNTIME_YAML_PATH,
) -> dict[str, dict]:
    """Return the base/runtime YAML layers plus their precedence-merged view.

    Blank values are dropped from every layer *before* merging, so an empty
    string in ``data/settings.runtime.yaml`` can never clobber
    ``configs/settings.yaml``, and neither can clobber the env layer.
    """
    base = {
        key: value
        for key, value in load_yaml_layer(yaml_path).items()
        if not is_blank_setting_value(value)
    }
    runtime_raw = load_yaml_layer(runtime_yaml_path)
    runtime = {
        key: value
        for key, value in runtime_raw.items()
        if not is_blank_setting_value(value)
    }
    merged = {**base, **runtime}
    return {"base_yaml": base, "runtime_yaml": runtime, "merged": merged}


def _field_env_candidates(name: str, field_info: Any) -> list[str]:
    """Env-var names that can populate a Settings field (upper-case)."""
    candidates = [name.upper()]
    alias = getattr(field_info, "validation_alias", None)
    if isinstance(alias, AliasChoices):
        for choice in alias.choices:
            text = str(choice).strip().upper()
            if text and text not in candidates:
                candidates.append(text)
    elif isinstance(alias, str) and alias.strip():
        text = alias.strip().upper()
        if text not in candidates:
            candidates.append(text)
    return candidates


def _load_dotenv_mapping(dotenv_path: str | Path) -> dict[str, str]:
    """Minimal KEY=VALUE .env reader (no interpolation, no export prefix)."""
    path = Path(dotenv_path)
    if not path.exists():
        return {}
    parsed: dict[str, str] = {}
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().removeprefix("export ").strip()
            value = value.strip().strip('"').strip("'")
            if key:
                parsed[key.upper()] = value
    except OSError:
        return {}
    return parsed


def build_env_layer(
    *,
    dotenv_path: str | Path = DEFAULT_DOTENV_PATH,
    fields: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """Map each Settings field name to its effective env-layer string value.

    Mirrors pydantic-settings resolution order inside the env layer: a real
    process environment variable beats a ``.env`` file entry. Blank env
    values still count as present here (unlike YAML), because explicitly
    setting ``FIELD=`` in the environment is a deliberate choice.
    """
    model_fields = fields if fields is not None else Settings.model_fields
    environ_upper = {key.upper(): value for key, value in os.environ.items()}
    dotenv = _load_dotenv_mapping(dotenv_path)
    layer: dict[str, str] = {}
    for name, info in model_fields.items():
        for candidate in _field_env_candidates(name, info):
            if candidate in environ_upper:
                layer[name] = environ_upper[candidate]
                break
            if candidate in dotenv:
                layer[name] = dotenv[candidate]
                break
    return layer


def read_settings_with_sources(
    settings: Settings,
    *,
    yaml_path: str | Path = DEFAULT_BASE_YAML_PATH,
    runtime_yaml_path: str | Path = DEFAULT_RUNTIME_YAML_PATH,
    dotenv_path: str | Path = DEFAULT_DOTENV_PATH,
) -> dict[str, dict[str, Any]]:
    """Read every Settings field as ``{"value": ..., "source_layer": ...}``.

    The reported ``source_layer`` is the strongest layer that actually
    supplies the field under the enforced chain
    ``default < env < base_yaml < runtime_yaml``.
    """
    layers = load_settings_layers(
        yaml_path=yaml_path,
        runtime_yaml_path=runtime_yaml_path,
    )
    env_layer = build_env_layer(dotenv_path=dotenv_path)
    sources: dict[str, dict[str, Any]] = {}
    for name in type(settings).model_fields:
        if name in layers["runtime_yaml"]:
            layer = "runtime_yaml"
        elif name in layers["base_yaml"]:
            layer = "base_yaml"
        elif name in env_layer:
            layer = "env"
        else:
            layer = "default"
        sources[name] = {"value": getattr(settings, name), "source_layer": layer}
    return sources


class SettingsPatchError(ValueError):
    """Raised when a settings PATCH payload fails typed server-side validation."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


_FIELD_ADAPTERS: dict[str, TypeAdapter] = {}


def _settings_field_adapter(field_name: str) -> TypeAdapter:
    adapter = _FIELD_ADAPTERS.get(field_name)
    if adapter is None:
        adapter = TypeAdapter(Settings.model_fields[field_name].annotation)
        _FIELD_ADAPTERS[field_name] = adapter
    return adapter


def validate_settings_patch(payload: Any) -> dict[str, Any]:
    """Validate a partial settings update against the typed Settings model.

    Every key must be a known ``Settings`` field and its value must coerce to
    that field's declared annotation (pydantic lax mode, same coercion the
    model itself applies). ``None`` values mean "not provided" and are
    dropped. Returns the validated/coerced patch; raises
    :class:`SettingsPatchError` listing *all* problems otherwise.
    """
    if not isinstance(payload, Mapping):
        raise SettingsPatchError([f"payload must be an object, got {type(payload).__name__}"])

    errors: list[str] = []
    validated: dict[str, Any] = {}
    for key, value in payload.items():
        if not isinstance(key, str) or key not in Settings.model_fields:
            errors.append(f"unknown settings field: {key!r}")
            continue
        if value is None:
            continue
        try:
            validated[key] = _settings_field_adapter(key).validate_python(value)
        except ValidationError as exc:
            first = exc.errors()[0]
            errors.append(f"{key}: {first.get('msg', 'invalid value')}")

    if errors:
        raise SettingsPatchError(errors)
    return validated


def persist_settings_patch(
    payload: Mapping[str, Any],
    *,
    base_yaml: str | Path = DEFAULT_BASE_YAML_PATH,
    runtime_yaml_path: str | Path = DEFAULT_RUNTIME_YAML_PATH,
) -> Path:
    """Validate a patch and persist it into the runtime YAML layer.

    The runtime layer (``data/settings.runtime.yaml``) is the strongest YAML
    layer, so persisted patches win over both base YAML and env on the next
    reload. Blank values are never written (empty-string clobber fix).
    """
    validated = validate_settings_patch(payload)
    target = Path(runtime_yaml_path)
    existing = {
        key: value
        for key, value in load_yaml_layer(target).items()
        if not is_blank_setting_value(value)
    }
    existing.update(validated)
    existing = {key: value for key, value in existing.items() if not is_blank_setting_value(value)}
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        yaml.safe_dump(existing, f, default_flow_style=False, allow_unicode=True)
    return target


def resolve_runtime_source_path(
    yaml_path: str | Path = DEFAULT_BASE_YAML_PATH,
    runtime_yaml_path: str | Path = DEFAULT_RUNTIME_YAML_PATH,
) -> Path:
    runtime_path = Path(runtime_yaml_path)
    if runtime_path.exists():
        return runtime_path
    return Path(yaml_path)


# Backwards-compatible alias for the historical private name.
_resolve_runtime_source_path = resolve_runtime_source_path


def build_browser_runtime_sync_status(
    *,
    runtime_json_path: str | Path = "data/browser.runtime.json",
    yaml_path: str | Path = "configs/settings.yaml",
    runtime_yaml_path: str | Path = "data/settings.runtime.yaml",
) -> dict:
    bridge_path = Path(runtime_json_path)
    source_path = _resolve_runtime_source_path(yaml_path=yaml_path, runtime_yaml_path=runtime_yaml_path)
    bridge_exists = bridge_path.exists()
    source_exists = source_path.exists()
    bridge_payload = {}

    if bridge_exists:
        try:
            bridge_payload = json.loads(bridge_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            bridge_payload = {}

    runtime_sync = bridge_payload.get("runtime_sync", {}) if isinstance(bridge_payload, dict) else {}
    source_mtime = source_path.stat().st_mtime if source_exists else None
    bridge_mtime = bridge_path.stat().st_mtime if bridge_exists else None
    stale = bool(
        source_exists
        and bridge_exists
        and source_mtime is not None
        and bridge_mtime is not None
        and bridge_mtime + 0.001 < source_mtime
    )

    return {
        "source_path": str(source_path.resolve()),
        "bridge_path": str(bridge_path.resolve()),
        "source_exists": source_exists,
        "bridge_exists": bridge_exists,
        "source_mtime": datetime.fromtimestamp(source_mtime, tz=UTC).isoformat() if source_mtime else "",
        "bridge_mtime": datetime.fromtimestamp(bridge_mtime, tz=UTC).isoformat() if bridge_mtime else "",
        "synced_at": str(runtime_sync.get("synced_at") or ""),
        "active_runtime_source": "runtime_yaml" if source_path == Path(runtime_yaml_path) else "base_yaml",
        "stale": stale,
    }


_RUNTIME_PROFILE_KEYS = ("classification", "landing", "hosting", "embedded", "orchestrator")
_RUNTIME_PROFILE_ALIASES = {
    "classification_agent": "classification",
    "landing_page": "landing",
    "landing_page_agent": "landing",
    "hosting_page": "hosting",
    "hosting_page_agent": "hosting",
    "embedded_page": "embedded",
    "embedded_page_agent": "embedded",
    "workflow": "orchestrator",
}
_RUNTIME_NUMERIC_FIELDS = {
    "tool_timeout_seconds": int,
    "llm_turn_timeout_seconds": int,
    "agent_timeout_seconds": int,
    "llm_retry_attempts": int,
    "llm_retry_base_delay_seconds": float,
    "llm_retry_max_delay_seconds": float,
    "repeated_tool_call_limit": int,
    "no_progress_turn_limit": int,
    "tool_result_cache_min_identical_observations": int,
}


def normalize_runtime_profile(value: str) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    return _RUNTIME_PROFILE_ALIASES.get(normalized, normalized)


def normalize_agent_runtime_config(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}

    normalized: dict[str, dict[str, Any]] = {}
    for raw_profile, raw_fields in value.items():
        profile = normalize_runtime_profile(str(raw_profile or ""))
        if profile not in _RUNTIME_PROFILE_KEYS or not isinstance(raw_fields, dict):
            continue

        cleaned: dict[str, Any] = {}
        for field, caster in _RUNTIME_NUMERIC_FIELDS.items():
            if field not in raw_fields or raw_fields[field] is None:
                continue
            try:
                cleaned[field] = caster(raw_fields[field])
            except (TypeError, ValueError):
                continue

        if "tool_timeout_seconds" in cleaned:
            cleaned["tool_timeout_seconds"] = max(1, int(cleaned["tool_timeout_seconds"]))
        if "llm_turn_timeout_seconds" in cleaned:
            cleaned["llm_turn_timeout_seconds"] = max(5, int(cleaned["llm_turn_timeout_seconds"]))
        if "agent_timeout_seconds" in cleaned:
            cleaned["agent_timeout_seconds"] = max(30, int(cleaned["agent_timeout_seconds"]))
        if "llm_retry_attempts" in cleaned:
            cleaned["llm_retry_attempts"] = max(1, int(cleaned["llm_retry_attempts"]))
        if "llm_retry_base_delay_seconds" in cleaned:
            cleaned["llm_retry_base_delay_seconds"] = max(
                0.0, float(cleaned["llm_retry_base_delay_seconds"])
            )
        if "llm_retry_max_delay_seconds" in cleaned:
            cleaned["llm_retry_max_delay_seconds"] = max(
                0.0, float(cleaned["llm_retry_max_delay_seconds"])
            )
        if "repeated_tool_call_limit" in cleaned:
            cleaned["repeated_tool_call_limit"] = max(1, int(cleaned["repeated_tool_call_limit"]))
        if "no_progress_turn_limit" in cleaned:
            cleaned["no_progress_turn_limit"] = max(1, int(cleaned["no_progress_turn_limit"]))
        if "tool_result_cache_min_identical_observations" in cleaned:
            cleaned["tool_result_cache_min_identical_observations"] = max(
                2, int(cleaned["tool_result_cache_min_identical_observations"])
            )

        if cleaned:
            normalized[profile] = cleaned

    return normalized


def resolve_agent_runtime_config(settings: Settings, profile: str) -> dict[str, Any]:
    normalized_profile = normalize_runtime_profile(profile)
    if normalized_profile not in _RUNTIME_PROFILE_KEYS:
        normalized_profile = "orchestrator"

    base_tool_timeout = max(1, int(getattr(settings, "tool_timeout_seconds", 30) or 30))
    base_agent_timeout = max(30, int(getattr(settings, "agent_timeout_seconds", 2700) or 2700))
    defaults: dict[str, Any] = {
        "tool_timeout_seconds": base_tool_timeout,
        "llm_turn_timeout_seconds": max(5, base_tool_timeout * 3),
        "agent_timeout_seconds": base_agent_timeout,
        "llm_retry_attempts": 3,
        "llm_retry_base_delay_seconds": 2.0,
        "llm_retry_max_delay_seconds": 20.0,
        "repeated_tool_call_limit": 3,
        "no_progress_turn_limit": 3,
        "tool_result_cache_min_identical_observations": max(
            2,
            int(getattr(settings, "tool_result_cache_min_identical_observations", 2) or 2),
        ),
    }

    if normalized_profile == "classification":
        defaults["agent_timeout_seconds"] = max(defaults["agent_timeout_seconds"], 1800)
    elif normalized_profile in {"landing", "hosting", "embedded"}:
        defaults["agent_timeout_seconds"] = max(defaults["agent_timeout_seconds"], 2700)
    elif normalized_profile == "orchestrator":
        defaults["agent_timeout_seconds"] = max(defaults["agent_timeout_seconds"], 7200)

    overrides = normalize_agent_runtime_config(getattr(settings, "agent_runtime_config", {})).get(
        normalized_profile, {}
    )
    resolved = {**defaults, **overrides}
    resolved["profile"] = normalized_profile
    return resolved


class Settings(BaseSettings):
    # T36: populate_by_name lets from_yaml() pass YAML keys by FIELD name even
    # for fields that declare an env validation_alias; without it those YAML
    # keys were silently ignored and the alias' env var was the only way to
    # set them, breaking the documented default < env < yaml chain.
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # LiteLLM routing; bare model names are prefixed at call time (src/llm/provider.py).
    llm_provider: str = "litellm"
    # Optional api_base override for OpenAI-compatible endpoints.
    llm_base_url: str | None = None

    orchestrator_model: str = "gemini-2.5-flash-lite"
    agent_model: str = "gemini-2.5-flash"
    gemini_model: str = "gemini-2.5-flash"
    gemini_temperature: float = 0.0
    llm_tuning: dict = Field(default_factory=dict)
    agent_model_config: dict = Field(default_factory=dict)
    provider_model_catalog_cache: dict = Field(default_factory=dict)

    google_api_key: str = ""
    google_vertex_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    mistral_api_key: str = ""
    cohere_api_key: str = ""
    groq_api_key: str = ""
    together_api_key: str = ""
    fireworks_api_key: str = ""
    perplexity_api_key: str = ""
    deepseek_api_key: str = ""
    xai_api_key: str = ""
    upstage_api_key: str = ""
    azure_api_key: str = ""
    azure_api_base: str = ""
    bedrock_api_key: str = ""
    # Extensible provider credentials and endpoints configured from Settings UI.
    # Values are persisted only in the runtime YAML layer and never returned raw.
    provider_api_keys: dict[str, str] = Field(default_factory=dict)
    provider_base_urls: dict[str, str] = Field(default_factory=dict)

    observability_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("OBSERVABILITY_ENABLED"),
    )
    observability_project_name: str = Field(
        default="open-web-catcher",
        validation_alias=AliasChoices("OBSERVABILITY_PROJECT_NAME"),
    )
    default_dataset_name: str = Field(
        default="open-web-catcher-runs",
        validation_alias=AliasChoices("OBSERVABILITY_DEFAULT_DATASET_NAME"),
    )
    dataset_dir: str = Field(
        default="data/datasets",
        validation_alias=AliasChoices("OBSERVABILITY_DATASET_DIR"),
    )
    model_pricing_json: str = Field(
        default="{}",
        validation_alias=AliasChoices("MODEL_PRICING_JSON"),
    )
    provider_pricing_sync_enabled: bool = Field(
        default=True,
        validation_alias=AliasChoices("PROVIDER_PRICING_SYNC_ENABLED"),
    )
    provider_pricing_timeout_seconds: int = Field(
        default=15,
        validation_alias=AliasChoices("PROVIDER_PRICING_TIMEOUT_SECONDS"),
    )
    provider_pricing_max_models: int = Field(
        default=300,
        validation_alias=AliasChoices("PROVIDER_PRICING_MAX_MODELS"),
    )
    ui_cors_origins: str = Field(
        default="http://localhost:3001,http://127.0.0.1:3001",
        validation_alias=AliasChoices("UI_CORS_ORIGINS"),
    )
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""
    cloudinary_upload_preset: str = ""
    browser_ws_endpoint: str = "ws://localhost:9223"
    mcp_server_url: str = "http://localhost:3001"
    # Playwright-only since ADR-003; the puppeteer engine/field pair was removed.
    browser_engine: str = Field(
        default="playwright",
        validation_alias=AliasChoices("BROWSER_ENGINE"),
    )
    mcp_server_url_playwright: str = Field(
        default="http://localhost:3001",
        validation_alias=AliasChoices("MCP_SERVER_URL_PLAYWRIGHT"),
    )

    ipinfo_token: str = ""
    database_url: str = "sqlite:///./data/open_web_catcher.db"

    # Redis run-state store (plan T17 / ADR-002). Empty disables the run store
    # explicitly; unreachable Redis degrades to in-process signals with a single
    # warning (never silent).
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("REDIS_URL"),
    )

    # Auth foundation (plan T3): JWT secret must be set via AUTH_JWT_SECRET;
    # empty value fails fast at first use (src/api/auth/security.py).
    auth_jwt_secret: str = ""
    auth_token_expiry_minutes: int = 720

    log_level: str = "INFO"
    log_file: str = "data/logs/app.log"

    classification_max_tool_calls: int = 5
    # Confidence gate thresholds (0-100); behavior documented on route_after_classification.
    classification_confidence_gate_low: int = 40
    classification_confidence_gate_high: int = 70
    # OCR/logo enrichment after classification; degrades gracefully when optional deps are missing.
    ocr_enabled: bool = True
    ocr_min_confidence: float = 0.35
    static_prepass_enabled: bool = False
    landing_page_max_tool_calls: int = 50
    hosting_page_max_tool_calls: int = 20
    embedded_page_max_tool_calls: int = 20
    orchestrator_max_tool_calls: int = 60

    tool_timeout_seconds: int = 30
    agent_timeout_seconds: int = 2700
    workflow_timeout_seconds: int = Field(
        default=3600,
        validation_alias=AliasChoices("WORKFLOW_TIMEOUT_SECONDS", "WORKFLOW_TIMEOUT"),
        description="Global wall-clock deadline for a full pipeline run (T30/AGT-H3).",
    )
    workflow_max_cost_usd: float = Field(
        default=0.0,
        validation_alias=AliasChoices("WORKFLOW_MAX_COST_USD", "WORKFLOW_BUDGET_USD"),
        description="Per-run cost budget in USD; 0 disables the governor (T30/AGT-M7).",
    )
    workflow_max_tokens: int = Field(
        default=0,
        validation_alias=AliasChoices("WORKFLOW_MAX_TOKENS", "WORKFLOW_TOKEN_BUDGET"),
        description="Per-run total-token budget; 0 disables the governor (T30/AGT-M7).",
    )
    background_job_retention_days: int = 30
    background_job_concurrency: int = 1

    # Retention windows per artifact family, in days (plan task 32).
    retention_days_runs: int = 30
    retention_days_run_snapshots: int = 30
    retention_days_llm_calls: int = 30
    retention_days_tool_calls: int = 30
    retention_days_agent_outputs: int = 30

    # Inline payload cap in bytes (plan task 32): result_full/content_full
    # values larger than this overflow to data/blobs/ as "blobref:" pointers.
    payload_cap_bytes: int = 8192

    memory_enabled: bool = True
    memory_db_path: str = "data/site_memory.db"
    memory_prompt_limit: int = 6
    memory_short_window: int = 40
    # NOTE: redis_url is declared once above (Redis run-state store, ADR-002);
    # a duplicate declaration here previously shadowed it silently.
    context_continuation_enabled: bool = True
    context_continuation_threshold: float = 0.8
    context_continuation_max: int = 4
    prompt_cache_enabled: bool = True
    prompt_cache_mode: str = "provider_hook"
    prompt_cache_min_chars: int = 2000
    provider_cache_enabled: bool = True
    gemini_explicit_cache_enabled: bool = True
    gemini_explicit_cache_ttl_seconds: int = 1800
    gemini_explicit_cache_refresh_lead_seconds: int = 120
    tool_result_cache_enabled: bool = True
    tool_result_cache_min_identical_observations: int = 2
    agent_runtime_config: dict = Field(default_factory=dict)

    browser_runtime: dict = Field(default_factory=dict)

    max_parallel_hosting_pages: int = 5

    thinking_enabled: bool = False
    thinking_budget_tokens: int = 8000

    # Deployment mode (plan T31 / SCH-M6): "dev" makes strict validation fail
    # fast (e.g. unknown runtime-event kinds raise); any other value ("prod",
    # the default) coerces invalid payloads with a warning instead.
    environment: str = "prod"

    @property
    def is_dev(self) -> bool:
        """True when ``environment`` selects a development mode."""
        return str(self.environment).strip().lower() in {"dev", "development", "local"}

    @classmethod
    def from_yaml(
        cls,
        yaml_path: str | Path = DEFAULT_BASE_YAML_PATH,
        runtime_yaml_path: str | Path = DEFAULT_RUNTIME_YAML_PATH,
    ) -> Settings:
        """Load settings through the enforced precedence chain (T36).

        Resolution order (weakest to strongest): model defaults < env
        (os.environ, then ``.env``) < ``configs/settings.yaml`` <
        ``data/settings.runtime.yaml``. Runtime overrides keep UI edits
        persistent when ``configs`` is mounted read-only. Blank YAML values
        are treated as absent so they can never clobber a weaker layer.
        """
        layers = load_settings_layers(yaml_path=yaml_path, runtime_yaml_path=runtime_yaml_path)
        s = cls(**layers["merged"])
        # Playwright-only since ADR-003: pin the engine and track its MCP URL.
        s.browser_engine = "playwright"
        s.mcp_server_url = s.mcp_server_url_playwright
        return s

    def save_yaml(
        self,
        yaml_path: str | Path = "configs/settings.yaml",
        runtime_yaml_path: str | Path = "data/settings.runtime.yaml",
    ) -> Path:
        """Persist non-secret runtime fields.

        Preferred target is ``configs/settings.yaml``. If that path is not
        writable (for example, read-only volume mount), settings are written to
        ``data/settings.runtime.yaml`` instead.
        """
        primary_path = Path(yaml_path)
        fallback_path = Path(runtime_yaml_path)

        existing: dict = {}
        if primary_path.exists():
            with open(primary_path, encoding="utf-8") as f:
                loaded = yaml.safe_load(f) or {}
            if isinstance(loaded, dict):
                existing = loaded

        existing["llm_provider"] = self.llm_provider
        existing["browser_engine"] = self.browser_engine
        existing["agent_model"] = self.agent_model
        existing["orchestrator_model"] = self.orchestrator_model
        existing["gemini_temperature"] = self.gemini_temperature
        existing["llm_tuning"] = self.llm_tuning
        existing["agent_model_config"] = self.agent_model_config
        existing["provider_model_catalog_cache"] = self.provider_model_catalog_cache
        existing["prompt_cache_enabled"] = self.prompt_cache_enabled
        existing["provider_cache_enabled"] = self.provider_cache_enabled
        existing["gemini_explicit_cache_enabled"] = self.gemini_explicit_cache_enabled
        existing["gemini_explicit_cache_ttl_seconds"] = self.gemini_explicit_cache_ttl_seconds
        existing["gemini_explicit_cache_refresh_lead_seconds"] = self.gemini_explicit_cache_refresh_lead_seconds
        existing["tool_result_cache_enabled"] = self.tool_result_cache_enabled
        existing["tool_result_cache_min_identical_observations"] = self.tool_result_cache_min_identical_observations
        existing["agent_runtime_config"] = normalize_agent_runtime_config(self.agent_runtime_config)
        existing["browser_runtime"] = self.browser_runtime
        existing["max_parallel_hosting_pages"] = self.max_parallel_hosting_pages
        existing["background_job_concurrency"] = self.background_job_concurrency
        existing["thinking_enabled"] = self.thinking_enabled
        existing["thinking_budget_tokens"] = self.thinking_budget_tokens
        existing["observability_enabled"] = self.observability_enabled
        existing["background_job_retention_days"] = self.background_job_retention_days
        existing["retention_days_runs"] = self.retention_days_runs
        existing["retention_days_run_snapshots"] = self.retention_days_run_snapshots
        existing["retention_days_llm_calls"] = self.retention_days_llm_calls
        existing["retention_days_tool_calls"] = self.retention_days_tool_calls
        existing["retention_days_agent_outputs"] = self.retention_days_agent_outputs
        existing["payload_cap_bytes"] = self.payload_cap_bytes
        existing["workflow_max_cost_usd"] = self.workflow_max_cost_usd
        existing["workflow_max_tokens"] = self.workflow_max_tokens
        # BYOK — provider keys via Settings UI (runtime yaml), not .env
        existing["google_api_key"] = self.google_api_key
        existing["google_vertex_api_key"] = self.google_vertex_api_key
        existing["openai_api_key"] = self.openai_api_key
        existing["anthropic_api_key"] = self.anthropic_api_key
        existing["openrouter_api_key"] = self.openrouter_api_key
        existing["nvidia_api_key"] = self.nvidia_api_key
        existing["mistral_api_key"] = self.mistral_api_key
        existing["cohere_api_key"] = self.cohere_api_key
        existing["groq_api_key"] = self.groq_api_key
        existing["together_api_key"] = self.together_api_key
        existing["fireworks_api_key"] = self.fireworks_api_key
        existing["perplexity_api_key"] = self.perplexity_api_key
        existing["deepseek_api_key"] = self.deepseek_api_key
        existing["xai_api_key"] = self.xai_api_key
        existing["upstage_api_key"] = self.upstage_api_key
        existing["azure_api_key"] = self.azure_api_key
        existing["azure_api_base"] = self.azure_api_base
        existing["bedrock_api_key"] = self.bedrock_api_key
        existing["provider_api_keys"] = {
            key.strip().lower(): value
            for key, value in self.provider_api_keys.items()
            if isinstance(key, str) and key.strip() and not is_blank_setting_value(value)
        }
        existing["provider_base_urls"] = {
            key.strip().lower(): value.strip()
            for key, value in self.provider_base_urls.items()
            if isinstance(key, str)
            and key.strip()
            and isinstance(value, str)
            and value.strip()
        }

        try:
            primary_path.parent.mkdir(parents=True, exist_ok=True)
            with open(primary_path, "w", encoding="utf-8") as f:
                # Blank values are never written: an empty string on disk
                # would be ignored on reload anyway (T36 clobber fix), so
                # dropping it here keeps the YAML layer honest.
                yaml.safe_dump(
                    {k: v for k, v in existing.items() if not is_blank_setting_value(v)},
                    f,
                    default_flow_style=False,
                    allow_unicode=True,
                )
            return primary_path
        except OSError:
            fallback_existing: dict = {}
            if fallback_path.exists():
                with open(fallback_path, encoding="utf-8") as f:
                    loaded = yaml.safe_load(f) or {}
                if isinstance(loaded, dict):
                    fallback_existing = loaded
            fallback_existing.update(existing)
            fallback_path.parent.mkdir(parents=True, exist_ok=True)
            with open(fallback_path, "w", encoding="utf-8") as f:
                yaml.safe_dump(fallback_existing, f, default_flow_style=False, allow_unicode=True)
            return fallback_path

    def save_browser_runtime_bridge(
        self,
        runtime_json_path: str | Path = "data/browser.runtime.json",
        yaml_path: str | Path = "configs/settings.yaml",
        runtime_yaml_path: str | Path = "data/settings.runtime.yaml",
    ) -> Path:
        """Persist browser-runtime settings for Node-based MCP tool servers.

        The browser containers share the ``data`` volume with the API service, so
        this JSON bridge lets the Playwright MCP tool server pick up runtime
        config changes on the next session without a container restart.
        """

        target_path = Path(runtime_json_path)
        source_path = _resolve_runtime_source_path(yaml_path=yaml_path, runtime_yaml_path=runtime_yaml_path)
        synced_at = datetime.now(UTC).isoformat()
        payload = {
            "browser_engine": self.browser_engine,
            "browser_runtime": normalize_browser_runtime(getattr(self, "browser_runtime", {})),
            "runtime_sync": {
                "source_path": str(source_path.resolve()),
                "bridge_path": str(target_path.resolve()),
                "synced_at": synced_at,
                "active_runtime_source": "runtime_yaml" if source_path == Path(runtime_yaml_path) else "base_yaml",
            },
        }
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf-8")
        return target_path
