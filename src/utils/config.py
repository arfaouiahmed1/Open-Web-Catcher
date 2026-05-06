"""Application settings loaded from .env + settings.yaml."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path

import yaml
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.utils.browser_runtime import normalize_browser_runtime


def _resolve_runtime_source_path(
    yaml_path: str | Path = "configs/settings.yaml",
    runtime_yaml_path: str | Path = "data/settings.runtime.yaml",
) -> Path:
    runtime_path = Path(runtime_yaml_path)
    if runtime_path.exists():
        return runtime_path
    return Path(yaml_path)


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
        "source_mtime": datetime.fromtimestamp(source_mtime, tz=timezone.utc).isoformat() if source_mtime else "",
        "bridge_mtime": datetime.fromtimestamp(bridge_mtime, tz=timezone.utc).isoformat() if bridge_mtime else "",
        "synced_at": str(runtime_sync.get("synced_at") or ""),
        "active_runtime_source": "runtime_yaml" if source_path == Path(runtime_yaml_path) else "base_yaml",
        "stale": stale,
    }


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # LLM provider selection: google | google-vertex | openai | anthropic | openrouter | nvidia
    llm_provider: str = "google"

    orchestrator_model: str = "gemini-2.5-flash-lite"
    agent_model: str = "gemini-2.5-flash"
    gemini_model: str = "gemini-2.5-flash"
    gemini_temperature: float = 0.0
    llm_tuning: dict = Field(default_factory=dict)
    agent_model_config: dict = Field(default_factory=dict)

    google_api_key: str = ""
    google_vertex_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"

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

    browser_ws_endpoint: str = "ws://localhost:9222"
    mcp_server_url: str = "http://localhost:3000"
    browser_engine: str = Field(
        default="puppeteer",
        validation_alias=AliasChoices("BROWSER_ENGINE"),
    )
    mcp_server_url_puppeteer: str = Field(
        default="http://localhost:3000",
        validation_alias=AliasChoices("MCP_SERVER_URL_PUPPETEER"),
    )
    mcp_server_url_playwright: str = Field(
        default="http://localhost:3001",
        validation_alias=AliasChoices("MCP_SERVER_URL_PLAYWRIGHT"),
    )

    ipinfo_token: str = ""
    database_url: str = "sqlite:///./data/open_web_catcher.db"

    log_level: str = "INFO"
    log_file: str = "data/logs/app.log"

    classification_max_tool_calls: int = 5
    landing_page_max_tool_calls: int = 50
    hosting_page_max_tool_calls: int = 20
    embedded_page_max_tool_calls: int = 20
    orchestrator_max_tool_calls: int = 60

    tool_timeout_seconds: int = 30
    agent_timeout_seconds: int = 300
    background_job_retention_days: int = 30

    memory_enabled: bool = True
    memory_db_path: str = "data/site_memory.db"
    memory_prompt_limit: int = 6
    memory_short_window: int = 40
    prompt_cache_enabled: bool = True
    prompt_cache_mode: str = "provider_hook"
    prompt_cache_min_chars: int = 2000
    provider_cache_enabled: bool = True
    gemini_explicit_cache_enabled: bool = True
    gemini_explicit_cache_ttl_seconds: int = 1800
    gemini_explicit_cache_refresh_lead_seconds: int = 120
    tool_result_cache_enabled: bool = True
    tool_result_cache_min_identical_observations: int = 2

    # Per-profile disabled tool names: {"landing": ["screenshot", "play_media"], ...}
    disabled_tools_by_profile: dict = Field(default_factory=dict)
    disabled_tools_by_browser_profile: dict = Field(default_factory=dict)
    browser_runtime: dict = Field(default_factory=dict)

    max_parallel_hosting_pages: int = 5

    thinking_enabled: bool = False
    thinking_budget_tokens: int = 8000

    # DeepEval evaluation framework settings
    deepeval_provider: str = "openai"
    deepeval_model: str = "gpt-4o"
    deepeval_temperature: float = 0.0

    @classmethod
    def from_yaml(
        cls,
        yaml_path: str | Path = "configs/settings.yaml",
        runtime_yaml_path: str | Path = "data/settings.runtime.yaml",
    ) -> "Settings":
        """Load settings from base YAML and runtime overrides.

        Runtime overrides in ``data/settings.runtime.yaml`` take precedence.
        This keeps UI edits persistent when ``configs`` is mounted read-only.
        """
        merged: dict = {}
        for candidate in (Path(yaml_path), Path(runtime_yaml_path)):
            if not candidate.exists():
                continue
            with open(candidate, encoding="utf-8") as f:
                loaded = yaml.safe_load(f) or {}
            if isinstance(loaded, dict):
                merged.update(loaded)
        s = cls(**merged)
        # Ensure mcp_server_url tracks browser_engine when loaded from YAML.
        if s.browser_engine == "playwright":
            s.mcp_server_url = s.mcp_server_url_playwright
        elif s.browser_engine == "puppeteer":
            s.mcp_server_url = s.mcp_server_url_puppeteer
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
        existing["provider_cache_enabled"] = self.provider_cache_enabled
        existing["gemini_explicit_cache_enabled"] = self.gemini_explicit_cache_enabled
        existing["gemini_explicit_cache_ttl_seconds"] = self.gemini_explicit_cache_ttl_seconds
        existing["gemini_explicit_cache_refresh_lead_seconds"] = self.gemini_explicit_cache_refresh_lead_seconds
        existing["tool_result_cache_enabled"] = self.tool_result_cache_enabled
        existing["tool_result_cache_min_identical_observations"] = self.tool_result_cache_min_identical_observations
        existing["disabled_tools_by_profile"] = self.disabled_tools_by_profile
        existing["disabled_tools_by_browser_profile"] = self.disabled_tools_by_browser_profile
        existing["browser_runtime"] = self.browser_runtime
        existing["max_parallel_hosting_pages"] = self.max_parallel_hosting_pages
        existing["thinking_enabled"] = self.thinking_enabled
        existing["thinking_budget_tokens"] = self.thinking_budget_tokens
        existing["deepeval_provider"] = self.deepeval_provider
        existing["deepeval_model"] = self.deepeval_model
        existing["deepeval_temperature"] = self.deepeval_temperature

        try:
            primary_path.parent.mkdir(parents=True, exist_ok=True)
            with open(primary_path, "w", encoding="utf-8") as f:
                yaml.safe_dump(existing, f, default_flow_style=False, allow_unicode=True)
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
        this JSON bridge lets Playwright/Puppeteer pick up runtime config changes
        on the next session without a container restart.
        """

        target_path = Path(runtime_json_path)
        source_path = _resolve_runtime_source_path(yaml_path=yaml_path, runtime_yaml_path=runtime_yaml_path)
        synced_at = datetime.now(timezone.utc).isoformat()
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
