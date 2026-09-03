"""LLM construction and provider profile resolution for agent execution.

Provides:
- build_llm: construct ChatLiteLLM model with provider-appropriate tuning and capability enforcement
- capability preflight: rejects models with supports_tools=False
"""

from __future__ import annotations

from typing import Any

from src.llm.provider import ChatLiteLLM
from src.utils.config import Settings
from src.utils.provider_models import (
    normalize_gemini_model_id,
    provider_api_key,
    provider_base_url,
    resolve_agent_model_selection,
    resolve_llm_tuning,
    resolve_model_runtime_profile,
)


def _filter_llm_kwargs(values: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if key in allowed and value is not None}


def build_llm(
    settings: Settings,
    temperature: float | None = None,
    model_override: str | None = None,
    provider_override: str | None = None,
    agent_id: str | None = None,
) -> ChatLiteLLM:
    """Build the LiteLLM-backed chat model used by all agents.

    Normalizes model IDs per provider, resolves tuning keys via generic
    runtime profiles, and rejects models that lack tool calling support.
    """
    selection = resolve_agent_model_selection(settings, agent_id or "")
    provider_hint = (
        (provider_override or selection.get("provider") or settings.llm_provider or "litellm")
        .strip()
        .lower()
    )
    if provider_hint in {"gemini", "google_genai"}:
        provider_hint = "google"

    selection_model = selection.get("model") or ""
    raw_model_name = model_override or selection_model or settings.agent_model
    if not raw_model_name:
        raw_model_name = str(settings.agent_model or settings.gemini_model or "").strip()

    # Normalize model ID only for Google; other providers expect their native IDs
    if provider_hint == "google":
        model_name = normalize_gemini_model_id(raw_model_name)
    else:
        model_name = str(raw_model_name).strip()

    runtime_profile = resolve_model_runtime_profile(
        settings,
        model_id=model_name,
        provider=provider_hint,
    )

    # Preflight check: browser agents strictly require tool calling
    if not runtime_profile.get("supports_tools", True):
        raise ValueError(
            f"Configured model '{model_name}' on provider '{provider_hint}' does not support "
            "tool calling required by browser agents."
        )

    tuning = resolve_llm_tuning(
        settings,
        provider=provider_hint,
        model_name=model_name,
        agent_id=agent_id or "",
    )

    allowed_tuning_keys = set(
        runtime_profile.get("allowed_tuning_keys") or {"temperature", "top_p", "max_tokens"}
    )

    tuned_temperature = tuning.pop("temperature", None)
    if temperature is not None:
        temp = temperature
    elif tuned_temperature is not None:
        temp = tuned_temperature
    else:
        temp = getattr(settings, "agent_temperature", None) or settings.gemini_temperature or 0.1

    llm_kwargs: dict[str, Any] = _filter_llm_kwargs(tuning, allowed_tuning_keys)
    if "max_output_tokens" in llm_kwargs:
        llm_kwargs["max_tokens"] = llm_kwargs.pop("max_output_tokens")

    thinking_budget = (
        settings.thinking_budget_tokens
        if settings.thinking_enabled
        and runtime_profile.get("supports_reasoning_controls")
        else None
    )

    api_key = provider_api_key(settings, provider_hint) or None
    configured_provider_base = (getattr(settings, "provider_base_urls", {}) or {}).get(
        provider_hint, ""
    )
    api_base = (
        configured_provider_base
        or settings.llm_base_url
        or provider_base_url(settings, provider_hint)
        or None
    )
    if provider_hint == "openrouter" and settings.openrouter_base_url:
        api_base = settings.openrouter_base_url
    elif provider_hint == "nvidia" and settings.nvidia_base_url:
        api_base = settings.nvidia_base_url

    return ChatLiteLLM(
        model=model_name,
        provider_prefix=provider_hint,
        api_key=api_key,
        api_base=api_base,
        temperature=temp,
        caching=bool(settings.prompt_cache_enabled),
        thinking_budget_tokens=thinking_budget,
        **llm_kwargs,
    )
