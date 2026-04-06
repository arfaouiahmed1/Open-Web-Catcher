"""Application settings loaded from .env + settings.yaml."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── LLM models ────────────────────────────────────────────────────────────
    # Orchestrator uses a smaller/cheaper model — it only routes and coordinates.
    # Sub-agents use the full Flash model for tool-calling loops + vision.
    orchestrator_model: str = "gemini-2.5-flash-lite-preview-05-20"
    agent_model: str = "gemini-2.5-flash-preview-05-20"

    # Kept for backwards-compat — points to agent_model by default
    gemini_model: str = "gemini-2.5-flash-preview-05-20"
    gemini_temperature: float = 0.0

    google_api_key: str = ""

    phoenix_tracing: bool = Field(default=False, validation_alias=AliasChoices("PHOENIX_TRACING"))
    phoenix_api_key: str = Field(default="", validation_alias=AliasChoices("PHOENIX_API_KEY"))
    phoenix_project_name: str = Field(
        default="open-web-catcher",
        validation_alias=AliasChoices("PHOENIX_PROJECT_NAME"),
    )
    phoenix_collector_endpoint: str = Field(
        default="http://localhost:6006",
        validation_alias=AliasChoices("PHOENIX_COLLECTOR_ENDPOINT"),
    )
    phoenix_ui_url: str = Field(
        default="http://localhost:6006",
        validation_alias=AliasChoices("PHOENIX_UI_URL"),
    )
    phoenix_base_url: str = Field(
        default="http://localhost:6006",
        validation_alias=AliasChoices("PHOENIX_BASE_URL"),
    )
    phoenix_default_dataset_name: str = Field(
        default="open-web-catcher-runs",
        validation_alias=AliasChoices("PHOENIX_DEFAULT_DATASET_NAME"),
    )
    phoenix_dataset_dir: str = Field(
        default="data/datasets",
        validation_alias=AliasChoices("PHOENIX_DATASET_DIR"),
    )
    phoenix_model_pricing_json: str = Field(
        default="{}",
        validation_alias=AliasChoices("PHOENIX_MODEL_PRICING_JSON"),
    )

    # ── LangSmith ─────────────────────────────────────────────────────────────
    # Legacy fallback if Phoenix is disabled.
    langchain_tracing_v2: bool = Field(
        default=False,
        validation_alias=AliasChoices("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2"),
    )
    langchain_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("LANGSMITH_API_KEY", "LANGCHAIN_API_KEY"),
    )
    langchain_project: str = Field(
        default="open-web-catcher",
        validation_alias=AliasChoices("LANGSMITH_PROJECT", "LANGCHAIN_PROJECT"),
    )
    langsmith_endpoint: str = Field(
        default="https://api.smith.langchain.com",
        validation_alias=AliasChoices("LANGSMITH_ENDPOINT"),
    )
    langsmith_ui_url: str = Field(
        default="",
        validation_alias=AliasChoices("LANGSMITH_UI_URL"),
    )

    # ── Cloudinary ────────────────────────────────────────────────────────────
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""

    # ── Browser (used by the MCP server container, not Python directly) ──────
    browser_ws_endpoint: str = "ws://localhost:9222"

    # ── MCP server ────────────────────────────────────────────────────────────
    # The MCP server exposes Puppeteer tools per agent profile.
    # Python agents connect to this URL to get their tool set.
    mcp_server_url: str = "http://localhost:3000"

    # ── IPInfo ────────────────────────────────────────────────────────────────
    ipinfo_token: str = ""   # optional — free tier works without token (50k/month)

    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str = "sqlite:///./data/open_web_catcher.db"

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = "INFO"
    log_file: str = "data/logs/app.log"

    # ── Agent budgets ─────────────────────────────────────────────────────────
    classification_max_tool_calls: int = 5
    landing_page_max_tool_calls: int = 50
    hosting_page_max_tool_calls: int = 20
    embedded_page_max_tool_calls: int = 20

    # Orchestrator budget: 1 classify + 1 landing + N hosting + M embedded
    # + 2 for analyze + email tools + buffer
    orchestrator_max_tool_calls: int = 60

    # ── Timeouts (seconds) ────────────────────────────────────────────────────
    tool_timeout_seconds: int = 30
    agent_timeout_seconds: int = 300

    @classmethod
    def from_yaml(cls, yaml_path: str | Path = "configs/settings.yaml") -> "Settings":
        """Load settings, merging YAML overrides on top of env vars."""
        path = Path(yaml_path)
        overrides: dict = {}
        if path.exists():
            with open(path) as f:
                overrides = yaml.safe_load(f) or {}
        return cls(**overrides)
