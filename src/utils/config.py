"""Application settings loaded from .env + settings.yaml."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # LLM
    google_api_key: str = ""
    gemini_model: str = "gemini-1.5-flash"
    gemini_temperature: float = 0.0

    # LangSmith
    langchain_tracing_v2: bool = False
    langchain_api_key: str = ""
    langchain_project: str = "open-web-catcher"

    # Cloudinary
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""

    # Browser
    browser_ws_endpoint: str = "ws://localhost:9222"

    # Database
    database_url: str = "sqlite:///./data/open_web_catcher.db"

    # Logging
    log_level: str = "INFO"
    log_file: str = "data/logs/app.log"

    # Agent budgets (overridable via settings.yaml)
    classification_max_tool_calls: int = 5
    landing_page_max_tool_calls: int = 50
    hosting_page_max_tool_calls: int = 20
    embedded_page_max_tool_calls: int = 20

    # Timeouts (seconds)
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
