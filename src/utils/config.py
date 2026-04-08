"""Application settings loaded from .env + settings.yaml."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # LLM provider selection: google | openai | anthropic | openrouter
    llm_provider: str = "google"

    orchestrator_model: str = "gemini-2.5-flash-lite"
    agent_model: str = "gemini-2.5-flash"
    gemini_model: str = "gemini-2.5-flash"
    gemini_temperature: float = 0.0

    google_api_key: str = ""
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

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
    ui_cors_origins: str = Field(
        default="http://localhost:3001,http://127.0.0.1:3001",
        validation_alias=AliasChoices("UI_CORS_ORIGINS"),
    )

    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""

    browser_ws_endpoint: str = "ws://localhost:9222"
    mcp_server_url: str = "http://localhost:3000"

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

    memory_enabled: bool = True
    memory_db_path: str = "data/site_memory.db"
    memory_prompt_limit: int = 6
    memory_short_window: int = 40
    prompt_cache_enabled: bool = True
    prompt_cache_mode: str = "provider_hook"
    prompt_cache_min_chars: int = 2000

    @classmethod
    def from_yaml(cls, yaml_path: str | Path = "configs/settings.yaml") -> "Settings":
        """Load settings, merging YAML overrides on top of env vars."""
        path = Path(yaml_path)
        overrides: dict = {}
        if path.exists():
            with open(path, encoding="utf-8") as f:
                overrides = yaml.safe_load(f) or {}
        return cls(**overrides)

    def save_yaml(self, yaml_path: str | Path = "configs/settings.yaml") -> None:
        """Persist non-secret runtime fields back to settings.yaml."""
        path = Path(yaml_path)
        existing: dict = {}
        if path.exists():
            with open(path, encoding="utf-8") as f:
                existing = yaml.safe_load(f) or {}
        existing["llm_provider"] = self.llm_provider
        existing["agent_model"] = self.agent_model
        existing["orchestrator_model"] = self.orchestrator_model
        existing["gemini_temperature"] = self.gemini_temperature
        with open(path, "w", encoding="utf-8") as f:
            yaml.safe_dump(existing, f, default_flow_style=False, allow_unicode=True)
