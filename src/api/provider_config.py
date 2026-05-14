from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel

from src.utils.browser_runtime import (
    normalize_browser_runtime,
    normalize_disabled_tools_by_browser_profile,
)
from src.utils.config import (
    Settings,
    build_browser_runtime_sync_status,
    normalize_agent_runtime_config,
)
from src.utils.provider_models import (
    get_provider_model_catalog,
    normalize_agent_model_config,
    normalize_llm_tuning,
    resolve_agent_model_selection,
)


class ModelConfigRequest(BaseModel):
    llm_provider: str | None = None
    agent_model: str | None = None
    orchestrator_model: str | None = None
    gemini_temperature: float | None = None
    llm_tuning: dict | None = None
    agent_model_config: dict | None = None
    provider_cache_enabled: bool | None = None
    gemini_explicit_cache_enabled: bool | None = None
    gemini_explicit_cache_ttl_seconds: int | None = None
    gemini_explicit_cache_refresh_lead_seconds: int | None = None
    tool_result_cache_enabled: bool | None = None
    tool_result_cache_min_identical_observations: int | None = None
    thinking_enabled: bool | None = None
    thinking_budget_tokens: int | None = None
    max_parallel_hosting_pages: int | None = None
    browser_engine: str | None = None
    disabled_tools_by_profile: dict | None = None
    disabled_tools_by_browser_profile: dict | None = None
    browser_runtime: dict | None = None
    agent_runtime_config: dict | None = None


def ui_config_payload(
    settings: Settings,
    *,
    config_persisted: bool | None = None,
    config_persist_path: str = "",
    config_persist_error: str = "",
) -> dict[str, Any]:
    payload = {
        "llm_provider": settings.llm_provider,
        "agent_model": settings.agent_model,
        "orchestrator_model": settings.orchestrator_model,
        "gemini_temperature": settings.gemini_temperature,
        "llm_tuning": normalize_llm_tuning(getattr(settings, "llm_tuning", {})),
        "agent_model_config": normalize_agent_model_config(
            settings, getattr(settings, "agent_model_config", {})
        ),
        "provider_cache_enabled": settings.provider_cache_enabled,
        "gemini_explicit_cache_enabled": settings.gemini_explicit_cache_enabled,
        "gemini_explicit_cache_ttl_seconds": settings.gemini_explicit_cache_ttl_seconds,
        "gemini_explicit_cache_refresh_lead_seconds": (
            settings.gemini_explicit_cache_refresh_lead_seconds
        ),
        "tool_result_cache_enabled": settings.tool_result_cache_enabled,
        "tool_result_cache_min_identical_observations": (
            settings.tool_result_cache_min_identical_observations
        ),
        "thinking_enabled": getattr(settings, "thinking_enabled", False),
        "thinking_budget_tokens": getattr(settings, "thinking_budget_tokens", 8000),
        "browser_engine": settings.browser_engine,
        "max_parallel_hosting_pages": getattr(settings, "max_parallel_hosting_pages", 5),
        "mcp_server_url_puppeteer": settings.mcp_server_url_puppeteer,
        "mcp_server_url_playwright": settings.mcp_server_url_playwright,
        "disabled_tools_by_profile": settings.disabled_tools_by_profile,
        "disabled_tools_by_browser_profile": normalize_disabled_tools_by_browser_profile(
            getattr(settings, "disabled_tools_by_browser_profile", {}),
            legacy=getattr(settings, "disabled_tools_by_profile", {}),
        ),
        "browser_runtime": normalize_browser_runtime(
            getattr(settings, "browser_runtime", {})
        ),
        "browser_runtime_sync_status": build_browser_runtime_sync_status(),
        "agent_runtime_config": normalize_agent_runtime_config(
            getattr(settings, "agent_runtime_config", {})
        ),
        "api_keys": {
            "google": bool(settings.google_api_key),
        },
    }
    if config_persisted is not None:
        payload["config_persisted"] = config_persisted
        payload["config_persist_path"] = config_persist_path
        payload["config_persist_error"] = config_persist_error
    return payload


def apply_ui_config_update(
    settings: Settings,
    body: ModelConfigRequest,
    *,
    reset_settings_cache: Callable[[], None],
    sync_provider_pricing: Callable[[Settings, str], dict[str, Any]],
    logger: Any,
) -> dict[str, Any]:
    if body.llm_provider:
        if str(body.llm_provider).strip().lower() != "google":
            raise HTTPException(
                status_code=400, detail="Only the Google Gemini provider is supported."
            )
        settings.llm_provider = body.llm_provider
    if body.agent_model:
        settings.agent_model = body.agent_model
    if body.orchestrator_model:
        settings.orchestrator_model = body.orchestrator_model
    if body.gemini_temperature is not None:
        settings.gemini_temperature = body.gemini_temperature
    if body.llm_tuning is not None:
        settings.llm_tuning = normalize_llm_tuning(body.llm_tuning)
    if body.agent_model_config is not None:
        settings.agent_model_config = normalize_agent_model_config(
            settings, body.agent_model_config
        )
        classification_selection = resolve_agent_model_selection(settings, "classification")
        orchestrator_selection = resolve_agent_model_selection(settings, "orchestrator")
        settings.agent_model = classification_selection.get("model", settings.agent_model)
        settings.orchestrator_model = orchestrator_selection.get(
            "model", settings.orchestrator_model
        )
    if body.provider_cache_enabled is not None:
        settings.provider_cache_enabled = body.provider_cache_enabled
    if body.gemini_explicit_cache_enabled is not None:
        settings.gemini_explicit_cache_enabled = body.gemini_explicit_cache_enabled
    if body.gemini_explicit_cache_ttl_seconds is not None:
        settings.gemini_explicit_cache_ttl_seconds = max(
            60, int(body.gemini_explicit_cache_ttl_seconds)
        )
    if body.gemini_explicit_cache_refresh_lead_seconds is not None:
        settings.gemini_explicit_cache_refresh_lead_seconds = max(
            5,
            int(body.gemini_explicit_cache_refresh_lead_seconds),
        )
    if body.tool_result_cache_enabled is not None:
        settings.tool_result_cache_enabled = body.tool_result_cache_enabled
    if body.tool_result_cache_min_identical_observations is not None:
        settings.tool_result_cache_min_identical_observations = max(
            2,
            int(body.tool_result_cache_min_identical_observations),
        )
    if body.thinking_enabled is not None:
        settings.thinking_enabled = body.thinking_enabled
    if body.thinking_budget_tokens is not None:
        settings.thinking_budget_tokens = max(
            1000, min(32000, int(body.thinking_budget_tokens))
        )
    if body.max_parallel_hosting_pages is not None:
        settings.max_parallel_hosting_pages = max(1, int(body.max_parallel_hosting_pages))
    if body.browser_engine in ("puppeteer", "playwright"):
        settings.browser_engine = body.browser_engine
        settings.mcp_server_url = (
            settings.mcp_server_url_playwright
            if body.browser_engine == "playwright"
            else settings.mcp_server_url_puppeteer
        )
    if body.disabled_tools_by_profile is not None:
        settings.disabled_tools_by_profile = body.disabled_tools_by_profile
    if body.disabled_tools_by_browser_profile is not None:
        settings.disabled_tools_by_browser_profile = normalize_disabled_tools_by_browser_profile(
            body.disabled_tools_by_browser_profile,
            legacy=body.disabled_tools_by_profile
            if body.disabled_tools_by_profile is not None
            else settings.disabled_tools_by_profile,
        )
    else:
        settings.disabled_tools_by_browser_profile = normalize_disabled_tools_by_browser_profile(
            getattr(settings, "disabled_tools_by_browser_profile", {}),
            legacy=settings.disabled_tools_by_profile,
        )
    if body.browser_runtime is not None:
        settings.browser_runtime = normalize_browser_runtime(body.browser_runtime)
    else:
        settings.browser_runtime = normalize_browser_runtime(
            getattr(settings, "browser_runtime", {})
        )
    if body.agent_runtime_config is not None:
        settings.agent_runtime_config = normalize_agent_runtime_config(
            body.agent_runtime_config
        )
    if body.agent_model_config is None:
        settings.agent_model_config = normalize_agent_model_config(
            settings, getattr(settings, "agent_model_config", {})
        )

    persist_path = ""
    persist_error = ""
    config_persisted = True
    try:
        persist_path = str(settings.save_yaml())
        reset_settings_cache()
    except Exception as exc:  # noqa: BLE001
        config_persisted = False
        persist_error = str(exc)
        logger.warning("Could not persist runtime settings: %s", exc)
    try:
        settings.save_browser_runtime_bridge()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not persist browser runtime bridge: %s", exc)

    pricing_sync: dict[str, Any] = {}
    if settings.provider_pricing_sync_enabled:
        try:
            pricing_sync = sync_provider_pricing(settings, settings.llm_provider)
        except Exception as exc:  # noqa: BLE001
            pricing_sync = {"provider": settings.llm_provider, "error": str(exc)}
            logger.warning("Provider pricing sync after config update failed: %s", exc)

    payload = ui_config_payload(
        settings,
        config_persisted=config_persisted,
        config_persist_path=persist_path,
        config_persist_error=persist_error,
    )
    payload["pricing_sync"] = pricing_sync
    return payload


def get_ui_provider_models(
    settings: Settings,
    *,
    provider: str,
    max_models: int,
    logger: Any,
) -> dict[str, Any]:
    normalized_provider = str(provider or "").strip().lower()
    if normalized_provider != "google":
        raise HTTPException(
            status_code=400, detail="Only the Google Gemini provider is supported."
        )

    payload = get_provider_model_catalog(
        settings, provider=normalized_provider, max_models=max_models
    )
    models = payload.get("models")
    if payload.get("source") == "provider_api" and isinstance(models, list) and models:
        cache = dict(getattr(settings, "provider_model_catalog_cache", {}) or {})
        cache[normalized_provider] = {
            "cached_at": datetime.now(datetime.UTC).isoformat(),
            "source": payload.get("source", "provider_api"),
            "models": models,
        }
        settings.provider_model_catalog_cache = cache
        try:
            settings.save_yaml()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not persist provider model catalog cache: %s", exc)
    return payload
