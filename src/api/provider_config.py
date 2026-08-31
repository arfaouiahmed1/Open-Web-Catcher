from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
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
    PROVIDER_METADATA,
    SUPPORTED_PROVIDERS,
    build_model_selection_details,
    collect_model_config_warnings,
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
    # Operations / retention / budgets (task 4).
    observability_enabled: bool | None = None
    background_job_retention_days: int | None = None
    retention_days_runs: int | None = None
    retention_days_run_snapshots: int | None = None
    retention_days_llm_calls: int | None = None
    retention_days_tool_calls: int | None = None
    retention_days_agent_outputs: int | None = None
    payload_cap_bytes: int | None = None
    workflow_max_cost_usd: float | None = None
    workflow_max_tokens: int | None = None
    # BYOK — provider keys via Settings UI (runtime yaml), not .env
    google_api_key: str | None = None
    google_vertex_api_key: str | None = None
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    openrouter_api_key: str | None = None
    nvidia_api_key: str | None = None
    mistral_api_key: str | None = None
    cohere_api_key: str | None = None
    groq_api_key: str | None = None
    together_api_key: str | None = None
    fireworks_api_key: str | None = None
    perplexity_api_key: str | None = None
    deepseek_api_key: str | None = None
    xai_api_key: str | None = None
    upstage_api_key: str | None = None
    azure_api_key: str | None = None
    azure_api_base: str | None = None
    bedrock_api_key: str | None = None
    provider_api_keys: dict[str, str] | None = None
    provider_base_urls: dict[str, str] | None = None


def ui_config_payload(
    settings: Settings,
    *,
    config_persisted: bool | None = None,
    config_persist_path: str = "",
    config_persist_error: str = "",
) -> dict[str, Any]:
    provider_keys = getattr(settings, "provider_api_keys", {}) or {}
    api_key_status = {
        "google": bool(settings.google_api_key),
        "openai": bool(settings.openai_api_key),
        "anthropic": bool(settings.anthropic_api_key),
        "openrouter": bool(settings.openrouter_api_key),
        "nvidia": bool(settings.nvidia_api_key),
        "mistral": bool(getattr(settings, "mistral_api_key", "")),
        "cohere": bool(getattr(settings, "cohere_api_key", "")),
        "groq": bool(getattr(settings, "groq_api_key", "")),
        "together": bool(getattr(settings, "together_api_key", "")),
        "fireworks": bool(getattr(settings, "fireworks_api_key", "")),
        "perplexity": bool(getattr(settings, "perplexity_api_key", "")),
        "deepseek": bool(getattr(settings, "deepseek_api_key", "")),
        "xai": bool(getattr(settings, "xai_api_key", "")),
        "upstage": bool(getattr(settings, "upstage_api_key", "")),
        "azure": bool(getattr(settings, "azure_api_key", "")),
        "bedrock": bool(getattr(settings, "bedrock_api_key", "")),
    }
    for provider_id in SUPPORTED_PROVIDERS:
        api_key_status[provider_id] = bool(
            api_key_status.get(provider_id)
            or (isinstance(provider_keys, dict) and provider_keys.get(provider_id))
        )

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
        "observability_enabled": getattr(settings, "observability_enabled", True),
        "background_job_retention_days": getattr(
            settings, "background_job_retention_days", 30
        ),
        "retention_days_runs": getattr(settings, "retention_days_runs", 30),
        "retention_days_run_snapshots": getattr(
            settings, "retention_days_run_snapshots", 30
        ),
        "retention_days_llm_calls": getattr(settings, "retention_days_llm_calls", 30),
        "retention_days_tool_calls": getattr(settings, "retention_days_tool_calls", 30),
        "retention_days_agent_outputs": getattr(
            settings, "retention_days_agent_outputs", 30
        ),
        "payload_cap_bytes": getattr(settings, "payload_cap_bytes", 8192),
        "workflow_max_cost_usd": getattr(settings, "workflow_max_cost_usd", 0.0),
        "workflow_max_tokens": getattr(settings, "workflow_max_tokens", 0),
        "api_keys": api_key_status,
        "provider_registry": [
            {
                "id": provider_id,
                "name": str(PROVIDER_METADATA[provider_id].get("name") or provider_id),
                "key_env": str(PROVIDER_METADATA[provider_id].get("key_env") or ""),
                "base_url": str(PROVIDER_METADATA[provider_id].get("base_url") or ""),
            }
            for provider_id in SUPPORTED_PROVIDERS
        ],
        "provider_base_urls": {
            **({"azure": settings.azure_api_base} if getattr(settings, "azure_api_base", "") else {}),
            **dict(getattr(settings, "provider_base_urls", {}) or {}),
        },
        "model_selection_details": build_model_selection_details(settings),
        "model_config_warnings": collect_model_config_warnings(settings),
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
        normalized_provider = str(body.llm_provider).strip().lower()
        if normalized_provider in {"gemini", "google_genai"}:
            normalized_provider = "google"
        if normalized_provider not in SUPPORTED_PROVIDERS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unsupported provider '{body.llm_provider}'. "
                    f"Supported: {', '.join(SUPPORTED_PROVIDERS)}."
                ),
            )
        settings.llm_provider = normalized_provider
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
    if body.observability_enabled is not None:
        settings.observability_enabled = body.observability_enabled
    if body.background_job_retention_days is not None:
        settings.background_job_retention_days = max(1, int(body.background_job_retention_days))
    for _retention_field in (
        "retention_days_runs",
        "retention_days_run_snapshots",
        "retention_days_llm_calls",
        "retention_days_tool_calls",
        "retention_days_agent_outputs",
    ):
        _retention_value = getattr(body, _retention_field)
        if _retention_value is not None:
            setattr(settings, _retention_field, max(1, int(_retention_value)))
    if body.payload_cap_bytes is not None:
        settings.payload_cap_bytes = max(1024, int(body.payload_cap_bytes))
    if body.workflow_max_cost_usd is not None:
        settings.workflow_max_cost_usd = max(0.0, float(body.workflow_max_cost_usd))
    if body.workflow_max_tokens is not None:
        settings.workflow_max_tokens = max(0, int(body.workflow_max_tokens))
    if body.browser_engine == "playwright":
        # Playwright-only since ADR-003; other engine values are ignored.
        settings.browser_engine = body.browser_engine
        settings.mcp_server_url = settings.mcp_server_url_playwright
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
    # BYOK: keys come from Settings UI; blank string = clear (remove from runtime yaml)
    for _key_field in ("google_api_key", "google_vertex_api_key", "openai_api_key", "anthropic_api_key", "openrouter_api_key", "nvidia_api_key", "mistral_api_key", "cohere_api_key", "groq_api_key", "together_api_key", "fireworks_api_key", "perplexity_api_key", "deepseek_api_key", "xai_api_key", "upstage_api_key", "azure_api_key", "azure_api_base", "bedrock_api_key"):
        _val = getattr(body, _key_field, None)
        if _val is not None:
            setattr(settings, _key_field, str(_val or "").strip())

    if body.provider_api_keys is not None:
        provider_keys = dict(getattr(settings, "provider_api_keys", {}) or {})
        for _provider_id, _value in body.provider_api_keys.items():
            _normalized_id = str(_provider_id or "").strip().lower()
            if _normalized_id not in SUPPORTED_PROVIDERS:
                raise HTTPException(status_code=400, detail=f"Unsupported provider '{_provider_id}'.")
            _normalized_value = str(_value or "").strip()
            if _normalized_value:
                provider_keys[_normalized_id] = _normalized_value
            else:
                provider_keys.pop(_normalized_id, None)
        settings.provider_api_keys = provider_keys

    if body.provider_base_urls is not None:
        provider_urls = dict(getattr(settings, "provider_base_urls", {}) or {})
        for _provider_id, _value in body.provider_base_urls.items():
            _normalized_id = str(_provider_id or "").strip().lower()
            if _normalized_id not in SUPPORTED_PROVIDERS:
                raise HTTPException(status_code=400, detail=f"Unsupported provider '{_provider_id}'.")
            _normalized_value = str(_value or "").strip()
            if _normalized_value:
                provider_urls[_normalized_id] = _normalized_value
            else:
                provider_urls.pop(_normalized_id, None)
        settings.provider_base_urls = provider_urls

    if body.agent_model_config is None:
        settings.agent_model_config = normalize_agent_model_config(
            settings, getattr(settings, "agent_model_config", {})
        )

    persist_path = ""
    persist_error = ""
    config_persisted = True
    # Ensure cleared keys are also removed from runtime yaml (save_yaml writes to base when writable)
    # so a plain "" must not linger in data/settings.runtime.yaml and shadow the clear.
    _clear_fields = []
    for _k in ("google_api_key", "google_vertex_api_key", "openai_api_key", "anthropic_api_key", "openrouter_api_key", "nvidia_api_key", "mistral_api_key", "cohere_api_key", "groq_api_key", "together_api_key", "fireworks_api_key", "perplexity_api_key", "deepseek_api_key", "xai_api_key", "upstage_api_key", "azure_api_key", "azure_api_base", "bedrock_api_key"):
        _v = getattr(body, _k, None)
        if _v is not None and not str(_v).strip():
            _clear_fields.append(_k)
    try:
        persist_path = str(settings.save_yaml())
        if _clear_fields:
            try:
                from pathlib import Path as _P
                import yaml as _yaml
                from src.utils.config import is_blank_setting_value as _is_blank
                _rt = _P("data/settings.runtime.yaml")
                if _rt.exists():
                    _data = _yaml.safe_load(_rt.read_text(encoding="utf-8")) or {}
                    if isinstance(_data, dict):
                        _changed = False
                        for _k in _clear_fields:
                            if _k in _data:
                                _data.pop(_k, None)
                                _changed = True
                        if _changed:
                            _rt.write_text(_yaml.safe_dump(_data, default_flow_style=False, allow_unicode=True), encoding="utf-8")
            except Exception:
                pass
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
    payload["apply_adjustments"] = payload.get("model_config_warnings", [])
    return payload


def get_ui_provider_models(
    settings: Settings,
    *,
    provider: str,
    max_models: int,
    logger: Any,
) -> dict[str, Any]:
    normalized_provider = str(provider or "").strip().lower()
    if normalized_provider in {"gemini", "google_genai"}:
        normalized_provider = "google"
    if normalized_provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported provider '{provider}'. "
                f"Supported: {', '.join(SUPPORTED_PROVIDERS)}."
            ),
        )

    payload = get_provider_model_catalog(
        settings, provider=normalized_provider, max_models=max_models
    )
    models = payload.get("models")
    if payload.get("source") == "provider_api" and isinstance(models, list) and models:
        cache = dict(getattr(settings, "provider_model_catalog_cache", {}) or {})
        cache[normalized_provider] = {
            "cached_at": datetime.now(timezone.utc).isoformat(),
            "source": payload.get("source", "provider_api"),
            "models": models,
        }
        settings.provider_model_catalog_cache = cache
        try:
            settings.save_yaml()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not persist provider model catalog cache: %s", exc)
    return payload
