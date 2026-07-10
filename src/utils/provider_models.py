"""Provider model catalog and runtime tuning helpers."""

from __future__ import annotations

import re
from typing import Any

import httpx

from src.utils.config import Settings


class ProviderModelCatalogError(RuntimeError):
    """Raised when live model catalog retrieval fails."""


PROVIDER_METADATA: dict[str, dict[str, str]] = {
    "google": {
        "id": "google",
        "name": "Google Gemini",
        "key_env": "GOOGLE_API_KEY",
    },
}


FALLBACK_MODELS: dict[str, list[dict[str, Any]]] = {
    "google": [
        {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "description": "Most capable Gemini model.", "context_window": 1_048_576},
        {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "description": "Balanced quality and speed.", "context_window": 1_048_576},
        {"id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash-Lite", "description": "Lower-cost Gemini option.", "context_window": 1_048_576},
        {"id": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash-Lite", "description": "Lower-cost Gemini 3.1 option.", "context_window": 1_048_576},
        {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash", "description": "Fast Gemini model.", "context_window": 1_048_576},
    ],
}


GOOGLE_MODEL_TUNING_KEYS = ("temperature", "top_p", "top_k", "max_output_tokens")


def _source_provenance_label(source: str) -> str:
    normalized = str(source or "").strip().lower()
    if normalized == "provider_api":
        return "Live from Google"
    if normalized == "saved_catalog":
        return "Saved snapshot"
    if normalized == "fallback_catalog":
        return "Fallback"
    return "Unknown"


def _thinking_support_from_model_name(model_id: str) -> tuple[bool, str]:
    normalized = normalize_gemini_model_id(model_id)
    if normalized.startswith(("gemini-2.5", "gemini-3", "google/gemini-2.5", "google/gemini-3")):
        return True, "Heuristic"
    if normalized.startswith(("gemma-", "google/gemma-")):
        return False, "Heuristic"
    return False, "Heuristic"


def _normalize_google_model_row(
    item: dict[str, Any],
    *,
    catalog_source: str,
    defaults_source: str,
) -> dict[str, Any]:
    model_id = str(item.get("id") or "").strip()
    if not model_id:
        return {}

    action_rows = item.get("supported_generation_methods") or item.get("supportedActions") or []
    actions = sorted(
        {
            str(action or "").strip()
            for action in action_rows
            if str(action or "").strip()
        }
    )
    default_parameters = dict(item.get("default_parameters") or {})
    default_parameter_provenance = {
        key: str(value)
        for key, value in dict(item.get("default_parameter_provenance") or {}).items()
        if key in GOOGLE_MODEL_TUNING_KEYS and value
    }
    for key in default_parameters:
        default_parameter_provenance.setdefault(key, _source_provenance_label(defaults_source))

    capabilities = dict(item.get("capabilities") or {})
    capability_provenance = {
        key: str(value)
        for key, value in dict(item.get("capability_provenance") or {}).items()
        if value
    }
    capability_provenance.setdefault("supports_generate_content", _source_provenance_label(catalog_source))
    capability_provenance.setdefault("supports_token_count", _source_provenance_label(catalog_source))
    capability_provenance.setdefault("supports_explicit_cache", _source_provenance_label(catalog_source))
    capability_provenance.setdefault("supports_batch", _source_provenance_label(catalog_source))

    if "supports_thinking_controls" not in capabilities:
        supports_thinking, provenance = _thinking_support_from_model_name(model_id)
        capabilities["supports_thinking_controls"] = supports_thinking
        capability_provenance["supports_thinking_controls"] = provenance
    else:
        capability_provenance.setdefault("supports_thinking_controls", _source_provenance_label(catalog_source))

    allowed_tuning_keys = [
        key for key in GOOGLE_MODEL_TUNING_KEYS if default_parameters.get(key) is not None
    ]
    if not allowed_tuning_keys:
        allowed_tuning_keys = list(GOOGLE_MODEL_TUNING_KEYS)
    capabilities["allowed_tuning_keys"] = allowed_tuning_keys
    capability_provenance["allowed_tuning_keys"] = (
        _source_provenance_label(defaults_source) if default_parameters else "Heuristic"
    )

    capabilities["thinking_status"] = (
        "supported" if capabilities.get("supports_thinking_controls") else "unsupported"
    )
    capabilities["explicit_cache_status"] = (
        "supported" if capabilities.get("supports_explicit_cache") else "unsupported"
    )

    return {
        **item,
        "id": model_id,
        "label": str(item.get("label") or model_id).strip(),
        "description": str(item.get("description") or "").strip(),
        "supported_generation_methods": actions,
        "default_parameters": default_parameters,
        "default_parameter_provenance": default_parameter_provenance,
        "capabilities": capabilities,
        "capability_provenance": capability_provenance,
        "catalog_source": catalog_source,
        "defaults_source": defaults_source,
        "compatibility": {
            "thinking_controls": capabilities["thinking_status"],
            "explicit_cache": capabilities["explicit_cache_status"],
            "allowed_tuning_keys": allowed_tuning_keys,
        },
    }


def _fallback_model_rows(provider: str, max_models: int) -> list[dict[str, Any]]:
    """Return normalized fallback rows with explicit fallback metadata."""

    rows: list[dict[str, Any]] = []
    for item in FALLBACK_MODELS.get(provider, [])[: max(1, int(max_models or 200))]:
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        normalized = _normalize_google_model_row(
            item,
            catalog_source="fallback_catalog",
            defaults_source="fallback_catalog",
        )
        if normalized:
            rows.append(normalized)
    return rows


def _saved_catalog_rows(settings: Settings, provider: str, max_models: int) -> list[dict[str, Any]]:
    cache = getattr(settings, "provider_model_catalog_cache", {})
    if not isinstance(cache, dict):
        return []
    provider_cache = cache.get(provider)
    if not isinstance(provider_cache, dict):
        return []
    raw_models = provider_cache.get("models")
    if not isinstance(raw_models, list):
        return []

    rows: list[dict[str, Any]] = []
    for item in raw_models[: max(1, int(max_models or 200))]:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        normalized = _normalize_google_model_row(
            item,
            catalog_source="saved_catalog",
            defaults_source=str(item.get("defaults_source") or "saved_catalog"),
        )
        if normalized:
            rows.append(normalized)
    return _dedupe_models(rows)


PROVIDER_TUNING_FIELDS: dict[str, list[dict[str, Any]]] = {
    "google": [
        {
            "key": "temperature",
            "label": "Temperature",
            "type": "number",
            "min": 0,
            "max": 2,
            "step": 0.1,
            "description": "Controls response randomness.",
        },
        {
            "key": "top_p",
            "label": "Top P",
            "type": "number",
            "min": 0,
            "max": 1,
            "step": 0.01,
            "description": "Nucleus sampling cutoff.",
        },
        {
            "key": "top_k",
            "label": "Top K",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Token candidate count for sampling.",
        },
        {
            "key": "max_output_tokens",
            "label": "Max Output Tokens",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Maximum tokens generated in a response.",
        },
    ],
    "google-vertex": [
        {
            "key": "temperature",
            "label": "Temperature",
            "type": "number",
            "min": 0,
            "max": 2,
            "step": 0.1,
            "description": "Controls response randomness.",
        },
        {
            "key": "top_p",
            "label": "Top P",
            "type": "number",
            "min": 0,
            "max": 1,
            "step": 0.01,
            "description": "Nucleus sampling cutoff.",
        },
        {
            "key": "top_k",
            "label": "Top K",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Token candidate count for sampling.",
        },
        {
            "key": "max_output_tokens",
            "label": "Max Output Tokens",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Maximum tokens generated in a response.",
        },
    ],
    "openai": [
        {
            "key": "temperature",
            "label": "Temperature",
            "type": "number",
            "min": 0,
            "max": 2,
            "step": 0.1,
            "description": "Controls response randomness.",
        },
        {
            "key": "top_p",
            "label": "Top P",
            "type": "number",
            "min": 0,
            "max": 1,
            "step": 0.01,
            "description": "Nucleus sampling cutoff.",
        },
        {
            "key": "max_tokens",
            "label": "Max Output Tokens",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Maximum tokens generated in a response.",
        },
        {
            "key": "reasoning_effort",
            "label": "Reasoning Effort",
            "type": "enum",
            "options": ["low", "medium", "high"],
            "description": "Extra reasoning budget for reasoning-capable models.",
            "model_patterns": ["^gpt-5", "^o[1-9]"],
        },
    ],
    "anthropic": [
        {
            "key": "temperature",
            "label": "Temperature",
            "type": "number",
            "min": 0,
            "max": 1,
            "step": 0.1,
            "description": "Controls response randomness.",
        },
        {
            "key": "top_p",
            "label": "Top P",
            "type": "number",
            "min": 0,
            "max": 1,
            "step": 0.01,
            "description": "Nucleus sampling cutoff.",
        },
        {
            "key": "top_k",
            "label": "Top K",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Token candidate count for sampling.",
        },
        {
            "key": "max_tokens",
            "label": "Max Output Tokens",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Maximum tokens generated in a response.",
        },
    ],
    "openrouter": [
        {
            "key": "temperature",
            "label": "Temperature",
            "type": "number",
            "min": 0,
            "max": 2,
            "step": 0.1,
            "description": "Controls response randomness.",
        },
        {
            "key": "top_p",
            "label": "Top P",
            "type": "number",
            "min": 0,
            "max": 1,
            "step": 0.01,
            "description": "Nucleus sampling cutoff.",
        },
        {
            "key": "top_k",
            "label": "Top K",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Provider-dependent token candidate count.",
        },
        {
            "key": "max_tokens",
            "label": "Max Output Tokens",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Maximum tokens generated in a response.",
        },
    ],
    "nvidia": [
        {
            "key": "temperature",
            "label": "Temperature",
            "type": "number",
            "min": 0,
            "max": 2,
            "step": 0.1,
            "description": "Controls response randomness.",
        },
        {
            "key": "top_p",
            "label": "Top P",
            "type": "number",
            "min": 0,
            "max": 1,
            "step": 0.01,
            "description": "Nucleus sampling cutoff.",
        },
        {
            "key": "max_tokens",
            "label": "Max Output Tokens",
            "type": "integer",
            "min": 1,
            "step": 1,
            "description": "Maximum tokens generated in a response.",
        },
        {
            "key": "enable_thinking",
            "label": "Enable Thinking",
            "type": "boolean",
            "description": "Chain-of-thought reasoning for supported models (e.g. z-ai/glm4.7).",
            "model_patterns": ["^z-ai/glm"],
        },
        {
            "key": "clear_thinking",
            "label": "Clear Thinking Trace",
            "type": "boolean",
            "description": "Strip the thinking trace from the final response.",
            "model_patterns": ["^z-ai/glm"],
        },
    ],
}

AGENT_MODEL_IDS = ("classification", "landing", "hosting", "embedded", "orchestrator")
AGENT_MODEL_ALIASES = {
    "classification": "classification",
    "classification_agent": "classification",
    "landing": "landing",
    "landing_page": "landing",
    "landing_page_agent": "landing",
    "hosting": "hosting",
    "hosting_page": "hosting",
    "hosting_page_agent": "hosting",
    "embedded": "embedded",
    "embedded_page": "embedded",
    "embedded_page_agent": "embedded",
    "orchestrator": "orchestrator",
    "orchestrator_agent": "orchestrator",
}

_GEMINI_MODEL_ALIASES = {
    "gemini-flash-lite-latest": "gemini-2.5-flash-lite",
    "gemini-flash-latest": "gemini-2.5-flash",
    "gemini-pro-latest": "gemini-2.5-pro",
    "google/gemini-flash-lite-latest": "google/gemini-2.5-flash-lite",
    "google/gemini-flash-latest": "google/gemini-2.5-flash",
    "google/gemini-pro-latest": "google/gemini-2.5-pro",
}


def normalize_llm_tuning(value: Any) -> dict[str, dict[str, dict[str, Any]]]:
    """Normalize persisted LLM tuning config."""

    provider_defaults: dict[str, dict[str, Any]] = {}
    model_overrides: dict[str, dict[str, Any]] = {}
    agent_overrides: dict[str, dict[str, Any]] = {}

    if isinstance(value, dict):
        raw_provider_defaults = value.get("provider_defaults", {})
        raw_model_overrides = value.get("model_overrides", {})
        raw_agent_overrides = value.get("agent_overrides", {})
        if isinstance(raw_provider_defaults, dict):
            for provider, params in raw_provider_defaults.items():
                if isinstance(provider, str) and isinstance(params, dict):
                    provider_defaults[provider.strip().lower()] = _sanitize_param_values(params)
        if isinstance(raw_model_overrides, dict):
            for key, params in raw_model_overrides.items():
                if isinstance(key, str) and isinstance(params, dict):
                    normalized_key = key.strip().lower()
                    if normalized_key:
                        model_overrides[normalized_key] = _sanitize_param_values(params)
        if isinstance(raw_agent_overrides, dict):
            for key, params in raw_agent_overrides.items():
                normalized_key = normalize_agent_id(key)
                if normalized_key and isinstance(params, dict):
                    agent_overrides[normalized_key] = _sanitize_param_values(params)

    return {
        "provider_defaults": provider_defaults,
        "model_overrides": model_overrides,
        "agent_overrides": agent_overrides,
    }


def resolve_llm_tuning(
    settings: Settings,
    provider: str,
    model_name: str,
    *,
    agent_id: str = "",
) -> dict[str, Any]:
    """Resolve provider defaults merged with model-specific overrides."""

    normalized_provider = (provider or "google").strip().lower()
    normalized_model = (model_name or "").strip()
    tuning = normalize_llm_tuning(getattr(settings, "llm_tuning", {}))
    resolved = dict(tuning["provider_defaults"].get(normalized_provider, {}))

    if normalized_model:
        override_key = f"{normalized_provider}::{normalized_model}".lower()
        resolved.update(tuning["model_overrides"].get(override_key, {}))

    normalized_agent = normalize_agent_id(agent_id)
    if normalized_agent:
        resolved.update(tuning["agent_overrides"].get(normalized_agent, {}))

    if resolved.get("temperature") is None:
        resolved["temperature"] = settings.gemini_temperature

    return _sanitize_param_values(resolved)


def normalize_agent_id(value: Any) -> str:
    """Normalize agent/config identifiers to stable UI/runtime keys."""

    normalized = str(value or "").strip().lower()
    if not normalized:
        return ""
    return AGENT_MODEL_ALIASES.get(normalized, normalized if normalized in AGENT_MODEL_IDS else "")


def normalize_agent_model_config(settings: Settings, value: Any) -> dict[str, dict[str, str]]:
    """Normalize per-agent model/provider selections with legacy fallbacks."""

    base_provider = (settings.llm_provider or "google").strip().lower() or "google"
    base_agent_model = str(settings.agent_model or "").strip()
    base_orchestrator_model = str(settings.orchestrator_model or base_agent_model).strip()
    defaults = {
        "classification": {"provider": base_provider, "model": base_agent_model},
        "landing": {"provider": base_provider, "model": base_agent_model},
        "hosting": {"provider": base_provider, "model": base_agent_model},
        "embedded": {"provider": base_provider, "model": base_agent_model},
        "orchestrator": {"provider": base_provider, "model": base_orchestrator_model},
    }

    if not isinstance(value, dict):
        return defaults

    normalized = {key: dict(item) for key, item in defaults.items()}
    for raw_agent, raw_config in value.items():
        agent_id = normalize_agent_id(raw_agent)
        if not agent_id or not isinstance(raw_config, dict):
            continue
        provider = str(raw_config.get("provider") or normalized[agent_id]["provider"] or base_provider).strip().lower()
        if provider in {"gemini", "google_genai"}:
            provider = "google"
        if provider != "google":
            provider = base_provider
        model = str(raw_config.get("model") or normalized[agent_id]["model"] or "").strip()
        normalized[agent_id] = {
            "provider": provider or base_provider,
            "model": model,
        }
    return normalized


def resolve_agent_model_selection(settings: Settings, agent_id: str) -> dict[str, str]:
    """Return the effective provider/model pair for one agent."""

    normalized_agent = normalize_agent_id(agent_id)
    config = normalize_agent_model_config(settings, getattr(settings, "agent_model_config", {}))
    if normalized_agent and normalized_agent in config:
        return config[normalized_agent]

    base_provider = (settings.llm_provider or "google").strip().lower() or "google"
    base_model = str(settings.orchestrator_model if normalized_agent == "orchestrator" else settings.agent_model or "").strip()
    return {"provider": base_provider, "model": base_model}


def find_provider_model_entry(
    settings: Settings,
    *,
    provider: str,
    model_id: str,
    max_models: int = 400,
) -> dict[str, Any] | None:
    normalized_provider = str(provider or "google").strip().lower() or "google"
    normalized_model = normalize_gemini_model_id(model_id)
    if not normalized_model:
        return None

    rows = _saved_catalog_rows(settings, normalized_provider, max_models) or _fallback_model_rows(
        normalized_provider, max_models
    )
    for row in rows:
        if normalize_gemini_model_id(str(row.get("id") or "")) == normalized_model:
            return row
    return None


def resolve_google_model_runtime_profile(
    settings: Settings,
    *,
    model_id: str,
    provider: str = "google",
) -> dict[str, Any]:
    normalized_model = normalize_gemini_model_id(model_id)
    model_entry = find_provider_model_entry(
        settings,
        provider=provider,
        model_id=normalized_model,
    )
    if model_entry:
        capabilities = dict(model_entry.get("capabilities") or {})
        compatibility = dict(model_entry.get("compatibility") or {})
        return {
            "model_id": normalized_model,
            "resolved_from_catalog": True,
            "catalog_source": model_entry.get("catalog_source", "unknown"),
            "defaults_source": model_entry.get("defaults_source", "unknown"),
            "capabilities": capabilities,
            "compatibility": compatibility,
            "allowed_tuning_keys": list(
                compatibility.get("allowed_tuning_keys")
                or capabilities.get("allowed_tuning_keys")
                or GOOGLE_MODEL_TUNING_KEYS
            ),
            "supports_thinking_controls": bool(
                capabilities.get("supports_thinking_controls", False)
            ),
            "supports_explicit_cache": bool(
                capabilities.get("supports_explicit_cache", False)
            ),
            "entry": model_entry,
        }

    supports_thinking_controls, thinking_provenance = _thinking_support_from_model_name(
        normalized_model
    )
    return {
        "model_id": normalized_model,
        "resolved_from_catalog": False,
        "catalog_source": "unverified_manual",
        "defaults_source": "unverified_manual",
        "capabilities": {
            "supports_thinking_controls": supports_thinking_controls,
            "supports_explicit_cache": False,
            "allowed_tuning_keys": list(GOOGLE_MODEL_TUNING_KEYS),
        },
        "compatibility": {
            "thinking_controls": "supported" if supports_thinking_controls else "unsupported",
            "explicit_cache": "unsupported",
            "allowed_tuning_keys": list(GOOGLE_MODEL_TUNING_KEYS),
        },
        "capability_provenance": {
            "supports_thinking_controls": thinking_provenance,
            "supports_explicit_cache": "Heuristic",
            "allowed_tuning_keys": "Heuristic",
        },
        "allowed_tuning_keys": list(GOOGLE_MODEL_TUNING_KEYS),
        "supports_thinking_controls": supports_thinking_controls,
        "supports_explicit_cache": False,
        "entry": None,
    }


def collect_model_config_warnings(settings: Settings) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    for agent_id in AGENT_MODEL_IDS:
        selection = resolve_agent_model_selection(settings, agent_id)
        model_name = str(selection.get("model") or "").strip()
        if not model_name:
            continue
        profile = resolve_google_model_runtime_profile(
            settings,
            model_id=model_name,
            provider=selection.get("provider") or "google",
        )
        if settings.thinking_enabled and not profile["supports_thinking_controls"]:
            warnings.append(
                {
                    "agent_id": agent_id,
                    "model": profile["model_id"],
                    "type": "thinking_disabled_for_model",
                    "message": (
                        f"{agent_id.capitalize()} uses {profile['model_id']}; "
                        "thinking controls will be ignored for this model."
                    ),
                    "provenance": (profile.get("entry") or {}).get("capability_provenance", {}).get(
                        "supports_thinking_controls",
                        profile.get("capability_provenance", {}).get(
                            "supports_thinking_controls", "Heuristic"
                        ),
                    ),
                }
            )
        if settings.gemini_explicit_cache_enabled and not profile["supports_explicit_cache"]:
            warnings.append(
                {
                    "agent_id": agent_id,
                    "model": profile["model_id"],
                    "type": "explicit_cache_unavailable_for_model",
                    "message": (
                        f"{agent_id.capitalize()} uses {profile['model_id']}; "
                        "explicit cache is unavailable for this model."
                    ),
                    "provenance": (profile.get("entry") or {}).get("capability_provenance", {}).get(
                        "supports_explicit_cache",
                        profile.get("capability_provenance", {}).get(
                            "supports_explicit_cache", "Heuristic"
                        ),
                    ),
                }
            )
    return warnings


def build_model_selection_details(settings: Settings) -> dict[str, Any]:
    warning_map: dict[str, list[dict[str, Any]]] = {}
    for item in collect_model_config_warnings(settings):
        warning_map.setdefault(str(item.get("agent_id") or ""), []).append(item)

    details: dict[str, Any] = {}
    for agent_id in AGENT_MODEL_IDS:
        selection = resolve_agent_model_selection(settings, agent_id)
        model_name = str(selection.get("model") or "").strip()
        if not model_name:
            details[agent_id] = {
                "provider": selection.get("provider") or "google",
                "model": "",
                "catalog_status": "missing",
                "warnings": [],
            }
            continue
        profile = resolve_google_model_runtime_profile(
            settings,
            model_id=model_name,
            provider=selection.get("provider") or "google",
        )
        matched_entry = profile.get("entry") or {}
        details[agent_id] = {
            "provider": selection.get("provider") or "google",
            "model": profile["model_id"],
            "label": str(matched_entry.get("label") or profile["model_id"]),
            "catalog_status": (
                "verified" if profile.get("resolved_from_catalog") else "unverified_manual"
            ),
            "catalog_source": profile.get("catalog_source"),
            "defaults_source": profile.get("defaults_source"),
            "capabilities": dict(profile.get("capabilities") or {}),
            "capability_provenance": dict(
                matched_entry.get("capability_provenance")
                or profile.get("capability_provenance")
                or {}
            ),
            "default_parameters": dict(matched_entry.get("default_parameters") or {}),
            "default_parameter_provenance": dict(
                matched_entry.get("default_parameter_provenance") or {}
            ),
            "warnings": warning_map.get(agent_id, []),
        }
    return details


def get_provider_model_catalog(settings: Settings, provider: str, max_models: int = 200) -> dict[str, Any]:
    """Return provider metadata, live model options, and tuning schema."""

    normalized_provider = (provider or "").strip().lower()
    if normalized_provider not in PROVIDER_METADATA:
        raise ProviderModelCatalogError(f"Unsupported provider '{provider}'.")

    metadata = dict(PROVIDER_METADATA[normalized_provider])
    api_key = _provider_api_key(settings, normalized_provider)
    saved_rows = _saved_catalog_rows(settings, normalized_provider, max_models)
    fallback_rows = _fallback_model_rows(normalized_provider, max_models)
    if normalized_provider != "openrouter" and not api_key:
        source = (
            "saved_catalog"
            if saved_rows
            else "fallback_catalog"
            if fallback_rows
            else "unavailable"
        )
        return {
            **metadata,
            "provider": normalized_provider,
            "api_key_set": False,
            "available": False,
            "source": source,
            "error": f"{metadata['key_env']} is not set. Live catalog unavailable.",
            "models": saved_rows or fallback_rows,
            "defaults_source": source,
            "live_catalog_available": False,
            "hyperparameters": PROVIDER_TUNING_FIELDS.get(normalized_provider, []),
        }

    try:
        models = fetch_provider_models(settings, normalized_provider, max_models=max_models)
        source = "provider_api"
        error = ""
        available = True
    except ProviderModelCatalogError as exc:
        models = saved_rows or fallback_rows
        source = "saved_catalog" if saved_rows else "fallback_catalog" if fallback_rows else "unavailable"
        error = str(exc)
        available = False

    return {
        **metadata,
        "provider": normalized_provider,
        "api_key_set": bool(api_key),
        "available": available,
        "source": source,
        "error": error,
        "models": models,
        "defaults_source": source,
        "live_catalog_available": available,
        "hyperparameters": PROVIDER_TUNING_FIELDS.get(normalized_provider, []),
    }


def fetch_provider_models(settings: Settings, provider: str, max_models: int = 200) -> list[dict[str, Any]]:
    """Fetch live model list for the selected provider."""

    normalized_provider = (provider or "").strip().lower()
    limit = max(1, int(max_models or 200))

    if normalized_provider == "google":
        return _fetch_google_models(settings, limit)
    raise ProviderModelCatalogError(
        f"Unsupported provider '{provider}'. Only Google Gemini is supported."
    )


def _fetch_google_models(settings: Settings, max_models: int) -> list[dict[str, Any]]:
    api_key = (settings.google_api_key or "").strip()
    if not api_key:
        raise ProviderModelCatalogError("GOOGLE_API_KEY is missing.")

    rows: list[dict[str, Any]] = []
    page_token = ""
    while len(rows) < max_models:
        params: dict[str, Any] = {"key": api_key, "pageSize": min(1000, max_models)}
        if page_token:
            params["pageToken"] = page_token
        payload = _request_json(
            "https://generativelanguage.googleapis.com/v1beta/models",
            params=params,
            timeout_seconds=settings.provider_pricing_timeout_seconds,
            provider="google",
        )
        for item in payload.get("models", []) or []:
            actions = item.get("supportedGenerationMethods") or item.get("supportedActions") or []
            if actions and "generateContent" not in actions:
                continue
            model_id = str(item.get("baseModelId") or item.get("name") or "").strip()
            if model_id.startswith("models/"):
                model_id = model_id.split("/", 1)[1]
            if not model_id:
                continue
            rows.append(
                _normalize_google_model_row(
                    {
                        "id": model_id,
                        "label": str(item.get("displayName") or model_id).strip(),
                        "description": str(item.get("description") or "").strip(),
                        "context_window": item.get("inputTokenLimit"),
                        "output_limit": item.get("outputTokenLimit"),
                        "default_parameters": _extract_google_model_defaults(item),
                        "default_parameter_provenance": _extract_google_default_parameter_provenance(
                            item
                        ),
                        "supported_generation_methods": actions,
                        "capabilities": _extract_google_model_capabilities(model_id, actions),
                        "capability_provenance": _extract_google_capability_provenance(
                            model_id, actions
                        ),
                        "release_channel": _google_model_release_channel(model_id),
                    },
                    catalog_source="provider_api",
                    defaults_source="provider_api",
                )
            )
            if len(rows) >= max_models:
                break
        page_token = str(payload.get("nextPageToken") or "").strip()
        if not page_token:
            break
    return _dedupe_models(rows)


def _extract_google_model_defaults(item: dict[str, Any]) -> dict[str, Any]:
    defaults: dict[str, Any] = {}
    for source_key, target_key in (
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("topK", "top_k"),
        ("outputTokenLimit", "max_output_tokens"),
    ):
        value = item.get(source_key)
        if value is None:
            continue
        defaults[target_key] = value
    return defaults


def _extract_google_default_parameter_provenance(item: dict[str, Any]) -> dict[str, str]:
    provenance: dict[str, str] = {}
    for source_key, target_key in (
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("topK", "top_k"),
        ("outputTokenLimit", "max_output_tokens"),
    ):
        if item.get(source_key) is not None:
            provenance[target_key] = "Live from Google"
    return provenance


def _extract_google_model_capabilities(model_id: str, actions: list[Any]) -> dict[str, bool]:
    normalized = str(model_id or "").strip().lower()
    action_set = {str(action or "").strip() for action in actions if str(action or "").strip()}
    supports_thinking_controls, _ = _thinking_support_from_model_name(normalized)
    return {
        "supports_generate_content": "generateContent" in action_set,
        "supports_token_count": "countTokens" in action_set,
        "supports_explicit_cache": "createCachedContent" in action_set,
        "supports_batch": "batchGenerateContent" in action_set,
        "supports_thinking_controls": supports_thinking_controls,
    }


def _extract_google_capability_provenance(model_id: str, actions: list[Any]) -> dict[str, str]:
    action_set = {str(action or "").strip() for action in actions if str(action or "").strip()}
    _, thinking_provenance = _thinking_support_from_model_name(model_id)
    return {
        "supports_generate_content": "Live from Google"
        if "generateContent" in action_set
        else "Live from Google",
        "supports_token_count": "Live from Google",
        "supports_explicit_cache": "Live from Google",
        "supports_batch": "Live from Google",
        "supports_thinking_controls": thinking_provenance,
    }


def _google_model_release_channel(model_id: str) -> str:
    normalized = str(model_id or "").strip().lower()
    if "preview" in normalized or "-exp-" in normalized or normalized.endswith("-exp"):
        return "preview"
    if "experimental" in normalized:
        return "experimental"
    return "stable"


def _fetch_google_vertex_models(settings: Settings, max_models: int) -> list[dict[str, Any]]:
    api_key = (settings.google_vertex_api_key or "").strip()
    if not api_key:
        raise ProviderModelCatalogError("GOOGLE_VERTEX_API_KEY is missing.")

    rows: list[dict[str, Any]] = []
    page_token = ""
    while len(rows) < max_models:
        params: dict[str, Any] = {"key": api_key, "pageSize": min(1000, max_models)}
        if page_token:
            params["pageToken"] = page_token
        payload = _request_json(
            "https://generativelanguage.googleapis.com/v1beta/models",
            params=params,
            timeout_seconds=settings.provider_pricing_timeout_seconds,
            provider="google-vertex",
        )
        for item in payload.get("models", []) or []:
            actions = item.get("supportedGenerationMethods") or item.get("supportedActions") or []
            if actions and "generateContent" not in actions:
                continue
            model_id = str(item.get("baseModelId") or item.get("name") or "").strip()
            if model_id.startswith("models/"):
                model_id = model_id.split("/", 1)[1]
            if not model_id:
                continue
            rows.append(
                {
                    "id": model_id,
                    "label": str(item.get("displayName") or model_id).strip(),
                    "description": str(item.get("description") or "").strip(),
                    "context_window": item.get("inputTokenLimit"),
                    "output_limit": item.get("outputTokenLimit"),
                }
            )
            if len(rows) >= max_models:
                break
        page_token = str(payload.get("nextPageToken") or "").strip()
        if not page_token:
            break
    return _dedupe_models(rows)


def _fetch_openai_models(settings: Settings, max_models: int) -> list[dict[str, Any]]:
    api_key = (settings.openai_api_key or "").strip()
    if not api_key:
        raise ProviderModelCatalogError("OPENAI_API_KEY is missing.")

    payload = _request_json(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout_seconds=settings.provider_pricing_timeout_seconds,
        provider="openai",
    )
    data = payload.get("data", []) or []
    rows = []
    for item in data:
        model_id = str(item.get("id") or "").strip()
        if not model_id or model_id.startswith("ft:"):
            continue
        rows.append(
            {
                "id": model_id,
                "label": model_id,
                "description": str(item.get("owned_by") or "").strip(),
                "created": item.get("created"),
                "context_window": resolve_model_context_window(model_id, "openai"),
            }
        )
    rows.sort(key=lambda entry: (-int(entry.get("created") or 0), str(entry["id"])))
    return _dedupe_models(rows[:max_models])


def _fetch_anthropic_models(settings: Settings, max_models: int) -> list[dict[str, Any]]:
    api_key = (settings.anthropic_api_key or "").strip()
    if not api_key:
        raise ProviderModelCatalogError("ANTHROPIC_API_KEY is missing.")

    rows: list[dict[str, Any]] = []
    after_id = ""
    while len(rows) < max_models:
        params: dict[str, Any] = {"limit": min(100, max_models - len(rows))}
        if after_id:
            params["after_id"] = after_id
        payload = _request_json(
            "https://api.anthropic.com/v1/models",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            params=params,
            timeout_seconds=settings.provider_pricing_timeout_seconds,
            provider="anthropic",
        )
        for item in payload.get("data", []) or []:
            model_id = str(item.get("id") or "").strip()
            if not model_id:
                continue
            rows.append(
                {
                    "id": model_id,
                    "label": str(item.get("display_name") or model_id).strip(),
                    "description": str(item.get("type") or "").strip(),
                    "created_at": str(item.get("created_at") or "").strip(),
                    "context_window": resolve_model_context_window(model_id, "anthropic"),
                }
            )
            if len(rows) >= max_models:
                break
        if not payload.get("has_more"):
            break
        after_id = str(payload.get("last_id") or "").strip()
        if not after_id:
            break
    return _dedupe_models(rows)


def _fetch_openrouter_models(settings: Settings, max_models: int) -> list[dict[str, Any]]:
    headers: dict[str, str] = {}
    api_key = (settings.openrouter_api_key or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = _request_json(
        f"{settings.openrouter_base_url.rstrip('/')}/models",
        headers=headers or None,
        timeout_seconds=settings.provider_pricing_timeout_seconds,
        provider="openrouter",
    )
    rows = []
    for item in payload.get("data", []) or []:
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        rows.append(
            {
                "id": model_id,
                "label": str(item.get("name") or item.get("canonical_slug") or model_id).strip(),
                "description": str(item.get("description") or "").strip(),
                "context_window": item.get("context_length"),
                "pricing": item.get("pricing"),
            }
        )
    return _dedupe_models(rows[:max_models])


def _fetch_nvidia_models(settings: Settings, max_models: int) -> list[dict[str, Any]]:
    api_key = (settings.nvidia_api_key or "").strip()
    base_url = (settings.nvidia_base_url or "https://integrate.api.nvidia.com/v1").rstrip("/")
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = _request_json(
        f"{base_url}/models",
        headers=headers or None,
        timeout_seconds=settings.provider_pricing_timeout_seconds,
        provider="nvidia",
    )
    rows = []
    for item in payload.get("data", []) or []:
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        context_window = (
            item.get("context_length")
            or item.get("context_window")
            or item.get("max_context_length")
            or resolve_model_context_window(model_id, "nvidia")
        )
        rows.append(
            {
                "id": model_id,
                "label": str(item.get("name") or model_id).strip(),
                "description": str(item.get("owned_by") or "").strip(),
                "created": item.get("created"),
                "context_window": int(context_window) if context_window else None,
            }
        )
    rows.sort(key=lambda r: (-int(r.get("created") or 0), r["id"]))
    return _dedupe_models(rows[:max_models])


def _request_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    timeout_seconds: int,
    provider: str,
) -> dict[str, Any]:
    try:
        response = httpx.get(url, headers=headers, params=params, timeout=max(5, int(timeout_seconds or 15)))
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ProviderModelCatalogError(f"{provider} model catalog request failed: {exc}") from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise ProviderModelCatalogError(f"{provider} model catalog returned invalid JSON.") from exc

    if not isinstance(payload, dict):
        raise ProviderModelCatalogError(f"{provider} model catalog response format was not recognized.")
    return payload


def _provider_api_key(settings: Settings, provider: str) -> str:
    normalized_provider = (provider or "").strip().lower()
    if normalized_provider == "google":
        return str(settings.google_api_key or "").strip()
    return ""

# Hardcoded context window fallbacks for providers whose APIs don't expose it.
# Values in tokens. Updated periodically; live catalog takes precedence when available.
_CONTEXT_WINDOW_FALLBACKS: dict[str, int] = {
    # OpenAI
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4.1": 1_047_576,
    "gpt-4.1-mini": 1_047_576,
    "gpt-4.1-nano": 1_047_576,
    "gpt-4-turbo": 128_000,
    "gpt-4": 8_192,
    "gpt-3.5-turbo": 16_385,
    "gpt-5": 1_047_576,
    "gpt-5-mini": 1_047_576,
    "gemini-2.5-pro": 1_048_576,
    "gemini-2.5-flash": 1_048_576,
    "gemini-2.5-flash-lite": 1_048_576,
    "gemini-3.1-flash-lite": 1_048_576,
    "gemini-2.0-flash": 1_048_576,
    "google/gemini-2.5-pro": 1_048_576,
    "google/gemini-2.5-flash": 1_048_576,
    "google/gemini-2.5-flash-lite": 1_048_576,
    "google/gemini-3.1-flash-lite": 1_048_576,
    "google/gemini-2.0-flash": 1_048_576,
    "openai/gpt-5": 1_047_576,
    "openai/gpt-5-mini": 1_047_576,
    "openai/gpt-4.1": 1_047_576,
    "openai/gpt-4o-mini": 128_000,
    "anthropic/claude-sonnet-4": 200_000,
    "anthropic/claude-opus-4": 200_000,
    "o1": 200_000,
    "o1-mini": 128_000,
    "o1-preview": 128_000,
    "o3": 200_000,
    "o3-mini": 200_000,
    "o4-mini": 200_000,
    # Anthropic
    "claude-3-5-haiku-latest": 200_000,
    "claude-3-5-sonnet-latest": 200_000,
    "claude-3-opus-latest": 200_000,
    "claude-3-7-sonnet-latest": 200_000,
    "claude-opus-4-20250514": 200_000,
    "claude-sonnet-4-20250514": 200_000,
    "claude-haiku-4-20250514": 200_000,
    # NVIDIA NIM — varies by underlying model
    "z-ai/glm4.7": 128_000,
    "nvidia/llama-3.1-nemotron-ultra-253b-v1": 128_000,
    "meta/llama-4-scout-17b-16e-instruct": 10_000_000,
    "nvidia/nemotron-4-340b-instruct": 4_096,
    "mistralai/mistral-nemo-12b-instruct": 128_000,
    "meta/llama-3.1-8b-instruct": 128_000,
    "meta/llama-3.1-70b-instruct": 128_000,
    "meta/llama-3.1-405b-instruct": 128_000,
    "meta/llama-3.3-70b-instruct": 128_000,
    "mistralai/mixtral-8x7b-instruct-v0.1": 32_768,
    "mistralai/mistral-7b-instruct-v0.3": 32_768,
    "google/gemma-3-27b-it": 131_072,
    "qwen/qwen3-235b-a22b": 40_960,
    "deepseek-ai/deepseek-r1": 64_000,
    "deepseek-ai/deepseek-r1-0528": 64_000,
}

# Prefix-based fallbacks for providers whose models share a common context window.
_CONTEXT_WINDOW_PREFIXES: list[tuple[str, int]] = [
    ("claude-opus-4", 200_000),
    ("claude-sonnet-4", 200_000),
    ("claude-haiku-4", 200_000),
    ("claude-3", 200_000),
    ("anthropic/claude-", 200_000),
    ("gpt-5", 1_047_576),
    ("openai/gpt-5", 1_047_576),
    ("gpt-4.1", 1_047_576),
    ("openai/gpt-4.1", 1_047_576),
    ("gpt-4o", 128_000),
    ("openai/gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("o4", 200_000),
    ("o3", 200_000),
    ("o1", 200_000),
    ("gemini-2.5", 1_048_576),
    ("gemini-3", 1_048_576),
    ("gemini-2.0", 1_048_576),
    ("google/gemini-2.5", 1_048_576),
    ("google/gemini-3", 1_048_576),
    ("google/gemini-2.0", 1_048_576),
    ("meta/llama-4", 10_000_000),
    ("meta/llama-3", 128_000),
    ("mistralai/", 128_000),
    ("nvidia/llama", 128_000),
    ("google/gemma", 131_072),
]


def normalize_gemini_model_id(model_id: str) -> str:
    key = str(model_id or "").strip().lower()
    if not key:
        return ""
    return _GEMINI_MODEL_ALIASES.get(key, key)


def is_google_genai_model_id(model_id: str) -> bool:
    normalized = normalize_gemini_model_id(model_id)
    return normalized.startswith(("gemini-", "gemma-", "google/gemini-", "google/gemma-"))


def resolve_model_context_window(model_id: str, provider: str = "") -> int | None:
    """Return context window token limit for a model. Returns None if unknown."""
    key = normalize_gemini_model_id((model_id or "").strip().lower())
    if not key:
        return None
    if key in _CONTEXT_WINDOW_FALLBACKS:
        return _CONTEXT_WINDOW_FALLBACKS[key]
    for prefix, window in _CONTEXT_WINDOW_PREFIXES:
        if key.startswith(prefix.lower()):
            return window
    return None


def _dedupe_models(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        model_id = str(row.get("id") or "").strip()
        if not model_id:
            continue
        normalized = model_id.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        item = dict(row)
        item["id"] = model_id
        item["label"] = str(item.get("label") or model_id).strip()
        deduped.append(item)
    return deduped


def _sanitize_param_values(params: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in params.items():
        if not isinstance(key, str):
            continue
        normalized_key = key.strip()
        if not normalized_key:
            continue
        if value is None or value == "":
            continue
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                continue
            if re.fullmatch(r"-?\d+", stripped):
                cleaned[normalized_key] = int(stripped)
                continue
            if re.fullmatch(r"-?\d+\.\d+", stripped):
                cleaned[normalized_key] = float(stripped)
                continue
            cleaned[normalized_key] = stripped
            continue
        cleaned[normalized_key] = value
    return cleaned
