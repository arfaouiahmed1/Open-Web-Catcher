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
    "openai": {
        "id": "openai",
        "name": "OpenAI",
        "key_env": "OPENAI_API_KEY",
    },
    "anthropic": {
        "id": "anthropic",
        "name": "Anthropic",
        "key_env": "ANTHROPIC_API_KEY",
    },
    "openrouter": {
        "id": "openrouter",
        "name": "OpenRouter",
        "key_env": "OPENROUTER_API_KEY",
    },
    "nvidia": {
        "id": "nvidia",
        "name": "NVIDIA NIM",
        "key_env": "NVIDIA_API_KEY",
    },
}


FALLBACK_MODELS: dict[str, list[dict[str, Any]]] = {
    "google": [
        {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "description": "Most capable Gemini model."},
        {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "description": "Balanced quality and speed."},
        {"id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash-Lite", "description": "Lower-cost Gemini option."},
        {"id": "gemini-2.0-flash", "label": "Gemini 2.0 Flash", "description": "Fast Gemini model."},
    ],
    "openai": [
        {"id": "gpt-5", "label": "gpt-5", "description": "Reasoning-capable flagship model."},
        {"id": "gpt-5-mini", "label": "gpt-5-mini", "description": "Smaller GPT-5 variant."},
        {"id": "gpt-4.1", "label": "gpt-4.1", "description": "General-purpose OpenAI model."},
        {"id": "gpt-4o-mini", "label": "gpt-4o-mini", "description": "Lower-cost multimodal model."},
    ],
    "anthropic": [
        {"id": "claude-opus-4-20250514", "label": "Claude Opus 4", "description": "Most capable Claude model."},
        {"id": "claude-sonnet-4-20250514", "label": "Claude Sonnet 4", "description": "Balanced Claude model."},
        {"id": "claude-3-7-sonnet-latest", "label": "Claude 3.7 Sonnet", "description": "Earlier Sonnet generation."},
        {"id": "claude-3-5-haiku-latest", "label": "Claude 3.5 Haiku", "description": "Faster Claude model."},
    ],
    "openrouter": [
        {"id": "openai/gpt-5", "label": "OpenAI / GPT-5", "description": "OpenAI model through OpenRouter."},
        {"id": "openai/gpt-5-mini", "label": "OpenAI / GPT-5 Mini", "description": "Smaller OpenAI model through OpenRouter."},
        {"id": "anthropic/claude-sonnet-4", "label": "Anthropic / Claude Sonnet 4", "description": "Anthropic model through OpenRouter."},
        {"id": "google/gemini-2.5-flash", "label": "Google / Gemini 2.5 Flash", "description": "Gemini model through OpenRouter."},
    ],
    "nvidia": [
        {"id": "z-ai/glm4.7", "label": "GLM-4.7 (Thinking)", "description": "ZhipuAI GLM-4.7 with optional chain-of-thought reasoning."},
        {"id": "nvidia/llama-3.1-nemotron-ultra-253b-v1", "label": "Llama 3.1 Nemotron Ultra 253B", "description": "NVIDIA fine-tuned Llama 3.1."},
        {"id": "meta/llama-4-scout-17b-16e-instruct", "label": "Llama 4 Scout 17B", "description": "Meta Llama 4 Scout via NVIDIA NIM."},
        {"id": "nvidia/nemotron-4-340b-instruct", "label": "Nemotron 4 340B Instruct", "description": "NVIDIA flagship instruction model."},
        {"id": "mistralai/mistral-nemo-12b-instruct", "label": "Mistral NeMo 12B", "description": "Mistral NeMo via NVIDIA NIM."},
    ],
}


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


def get_provider_model_catalog(settings: Settings, provider: str, max_models: int = 200) -> dict[str, Any]:
    """Return provider metadata, live model options, and tuning schema."""

    normalized_provider = (provider or "").strip().lower()
    if normalized_provider not in PROVIDER_METADATA:
        raise ProviderModelCatalogError(f"Unsupported provider '{provider}'.")

    metadata = dict(PROVIDER_METADATA[normalized_provider])
    api_key = _provider_api_key(settings, normalized_provider)
    source = "fallback"
    error = ""

    try:
        if normalized_provider != "openrouter" and not api_key:
            raise ProviderModelCatalogError(
                f"{metadata['key_env']} is not set. Showing fallback models until the provider API is available."
            )
        models = fetch_provider_models(settings, normalized_provider, max_models=max_models)
        source = "provider_api"
    except ProviderModelCatalogError as exc:
        models = _fallback_models(settings, normalized_provider)
        error = str(exc)

    return {
        **metadata,
        "provider": normalized_provider,
        "api_key_set": bool(api_key),
        "source": source,
        "error": error,
        "models": models,
        "hyperparameters": PROVIDER_TUNING_FIELDS.get(normalized_provider, []),
    }


def fetch_provider_models(settings: Settings, provider: str, max_models: int = 200) -> list[dict[str, Any]]:
    """Fetch live model list for the selected provider."""

    normalized_provider = (provider or "").strip().lower()
    limit = max(1, int(max_models or 200))

    if normalized_provider == "google":
        return _fetch_google_models(settings, limit)
    if normalized_provider == "openai":
        return _fetch_openai_models(settings, limit)
    if normalized_provider == "anthropic":
        return _fetch_anthropic_models(settings, limit)
    if normalized_provider == "openrouter":
        return _fetch_openrouter_models(settings, limit)
    if normalized_provider == "nvidia":
        return _fetch_nvidia_models(settings, limit)

    raise ProviderModelCatalogError(f"Unsupported provider '{provider}'.")


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
    if normalized_provider == "openai":
        return str(settings.openai_api_key or "").strip()
    if normalized_provider == "anthropic":
        return str(settings.anthropic_api_key or "").strip()
    if normalized_provider == "openrouter":
        return str(settings.openrouter_api_key or "").strip()
    if normalized_provider == "nvidia":
        return str(settings.nvidia_api_key or "").strip()
    return ""


def _fallback_models(settings: Settings, provider: str) -> list[dict[str, Any]]:
    rows = list(FALLBACK_MODELS.get(provider, []))
    pricing_models = _pricing_models_for_provider(settings, provider)
    current_models = []
    current_config = normalize_agent_model_config(settings, getattr(settings, "agent_model_config", {}))
    for agent_id, config in current_config.items():
        if str(config.get("provider") or "").strip().lower() != provider:
            continue
        model_id = str(config.get("model") or "").strip()
        if not model_id:
            continue
        current_models.append(
            {
                "id": model_id,
                "label": model_id,
                "description": f"Configured for {agent_id} agent.",
            }
        )
    return _dedupe_models(current_models + pricing_models + rows)


def _pricing_models_for_provider(settings: Settings, provider: str) -> list[dict[str, Any]]:
    raw = getattr(settings, "model_pricing_json", "{}") or "{}"
    if not isinstance(raw, str):
        return []
    try:
        import json

        payload = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(payload, dict):
        return []

    rows = []
    for model_name, config in payload.items():
        if not isinstance(model_name, str) or "::" in model_name:
            continue
        if not isinstance(config, dict):
            continue
        if str(config.get("provider") or "").strip().lower() != provider:
            continue
        rows.append(
            {
                "id": model_name.strip(),
                "label": model_name.strip(),
                "description": "From saved pricing catalog.",
            }
        )
    return rows


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
    ("gpt-5", 1_047_576),
    ("gpt-4.1", 1_047_576),
    ("gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("o4", 200_000),
    ("o3", 200_000),
    ("o1", 200_000),
    ("meta/llama-4", 10_000_000),
    ("meta/llama-3", 128_000),
    ("mistralai/", 128_000),
    ("nvidia/llama", 128_000),
    ("google/gemma", 131_072),
]


def resolve_model_context_window(model_id: str, provider: str = "") -> int | None:
    """Return context window token limit for a model. Returns None if unknown."""
    key = (model_id or "").strip().lower()
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
