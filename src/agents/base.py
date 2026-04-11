"""Shared LangGraph-based agent infrastructure."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from threading import Lock
from typing import TYPE_CHECKING, Annotated, Any, Callable, TypedDict

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.observability import RunObserver
from src.utils.instrumentation import (
    observability_span,
    resolve_model_pricing,
    set_span_attributes,
    set_span_output,
    using_observability_context,
)

logger = get_logger(__name__)

if TYPE_CHECKING:
    from src.memory.short_term import ShortTermMemory


class RunCancelledError(Exception):
    """Raised when a live run is cancelled from the UI."""


class BudgetExceededError(Exception):
    """Raised when the agent cannot make more tool calls."""


class AgentLoopResult:
    def __init__(self, final_text: str, tool_calls_made: int, messages: list[BaseMessage]) -> None:
        self.final_text = final_text
        self.tool_calls_made = tool_calls_made
        self.messages = messages

    def parse_json(self) -> dict[str, Any]:
        """Try to parse the final text as JSON. Strips markdown fences."""
        text = self.final_text.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            logger.warning("Could not parse agent output as JSON")
            return {}


class AgentGraphState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    tool_calls_made: int
    max_tool_calls: int
    budget_exhausted: bool


def _json_ready(value: Any) -> Any:
    """Convert provider payloads into JSON-safe data for runtime events."""
    if value is None:
        return {}
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    try:
        return json.loads(json.dumps(value, default=str))
    except Exception:
        return {"repr": repr(value)}


def _extract_usage(usage: Any) -> tuple[int, int]:
    usage_dict = usage if isinstance(usage, dict) else getattr(usage, "__dict__", {})
    input_tokens = int(
        usage_dict.get("input_tokens")
        or usage_dict.get("prompt_tokens")
        or usage_dict.get("input_token_count")
        or usage_dict.get("prompt_token_count")
        or 0
    )
    output_tokens = int(
        usage_dict.get("output_tokens")
        or usage_dict.get("completion_tokens")
        or usage_dict.get("candidates_token_count")
        or usage_dict.get("output_token_count")
        or 0
    )
    return input_tokens, output_tokens


def _to_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _extract_cache_counters(payload: Any) -> tuple[int, int, int]:
    """Extract cache counters from provider usage payloads.

    Returns ``(cached_tokens, cache_read_input_tokens, cache_creation_input_tokens)``.
    """

    payload_dict = payload if isinstance(payload, dict) else getattr(payload, "__dict__", {})
    if not isinstance(payload_dict, dict):
        return 0, 0, 0

    cached_tokens = 0
    cache_read_tokens = _to_int(payload_dict.get("cache_read_input_tokens"))
    cache_creation_tokens = _to_int(payload_dict.get("cache_creation_input_tokens"))

    input_details = payload_dict.get("input_token_details") or payload_dict.get("prompt_tokens_details") or {}
    if isinstance(input_details, dict):
        cached_tokens = max(cached_tokens, _to_int(input_details.get("cached_tokens")))
        cache_read_tokens = max(
            cache_read_tokens,
            _to_int(input_details.get("cache_read_input_tokens")),
            _to_int(input_details.get("cache_read")),
            _to_int(input_details.get("cache_read_tokens")),
        )
        cache_creation_tokens = max(
            cache_creation_tokens,
            _to_int(input_details.get("cache_creation_input_tokens")),
            _to_int(input_details.get("cache_creation")),
            _to_int(input_details.get("cache_creation_tokens")),
        )
        # Anthropic may expose TTL-scoped cache writes in separate counters.
        ttl_scoped_writes = (
            _to_int(input_details.get("ephemeral_5m_input_tokens"))
            + _to_int(input_details.get("ephemeral_1h_input_tokens"))
        )
        cache_creation_tokens = max(cache_creation_tokens, ttl_scoped_writes)

    return cached_tokens, cache_read_tokens, cache_creation_tokens


def _extract_cache_metrics(usage: Any, response: AIMessage | None = None) -> dict[str, Any]:
    usage_dict = usage if isinstance(usage, dict) else getattr(usage, "__dict__", {})
    response_metadata = getattr(response, "response_metadata", None) if response is not None else None
    additional_kwargs = getattr(response, "additional_kwargs", None) if response is not None else None
    response_dict = response_metadata if isinstance(response_metadata, dict) else getattr(response_metadata, "__dict__", {})
    kwargs_dict = additional_kwargs if isinstance(additional_kwargs, dict) else getattr(additional_kwargs, "__dict__", {})

    input_tokens = _to_int(
        usage_dict.get("input_tokens")
        or usage_dict.get("prompt_tokens")
        or usage_dict.get("input_token_count")
        or usage_dict.get("prompt_token_count")
    )
    output_tokens = _to_int(
        usage_dict.get("output_tokens")
        or usage_dict.get("completion_tokens")
        or usage_dict.get("candidates_token_count")
        or usage_dict.get("output_token_count")
    )

    cached_tokens, cache_read_input_tokens, cache_creation_input_tokens = _extract_cache_counters(usage_dict)

    response_usage = response_dict.get("token_usage") if isinstance(response_dict, dict) else {}
    response_cached_tokens, response_cache_read, response_cache_creation = _extract_cache_counters(response_usage)
    cached_tokens = max(cached_tokens, response_cached_tokens)
    cache_read_input_tokens = max(cache_read_input_tokens, response_cache_read)
    cache_creation_input_tokens = max(cache_creation_input_tokens, response_cache_creation)

    kwargs_usage = kwargs_dict.get("usage") or kwargs_dict.get("token_usage") if isinstance(kwargs_dict, dict) else {}
    kwargs_cached_tokens, kwargs_cache_read, kwargs_cache_creation = _extract_cache_counters(kwargs_usage)
    cached_tokens = max(cached_tokens, kwargs_cached_tokens)
    cache_read_input_tokens = max(cache_read_input_tokens, kwargs_cache_read)
    cache_creation_input_tokens = max(cache_creation_input_tokens, kwargs_cache_creation)

    if cache_read_input_tokens:
        cached_tokens = max(cached_tokens, cache_read_input_tokens)
    cached_tokens = max(cached_tokens, 0)

    # Anthropic reports ``input_tokens`` as the uncached tail when cache counters
    # are present. Keep the reported suffix as new-input tokens in that case.
    if cache_read_input_tokens > 0 and cached_tokens > input_tokens:
        new_input_tokens = max(input_tokens, 0)
    else:
        new_input_tokens = max(input_tokens - cached_tokens, 0)

    return {
        "cache_hit": cached_tokens > 0 or cache_read_input_tokens > 0,
        "cached_input_tokens": cached_tokens,
        "new_input_tokens": new_input_tokens,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read_input_tokens,
        "cache_creation_input_tokens": cache_creation_input_tokens,
    }


def _build_provider_cache_invoke_kwargs(
    settings: Settings,
    *,
    provider: str,
    prompt_metadata: dict[str, Any],
    allow_google_explicit_cache: bool = True,
) -> dict[str, Any]:
    if not settings.provider_cache_enabled or not settings.prompt_cache_enabled:
        return {}

    if not bool(prompt_metadata.get("provider_cache_eligible", False)):
        return {}

    cache_mode = str(prompt_metadata.get("cache_mode", "") or "").strip().lower()
    if cache_mode not in {"provider_hook", "provider_active"}:
        return {}

    cache_key = str(prompt_metadata.get("provider_cache_key", "") or "").strip()

    if provider == "openrouter":
        if not cache_key:
            return {}
        return {
            "extra_headers": {
                "x-openrouter-prompt-cache-key": cache_key,
            }
        }

    if provider == "openai":
        if not cache_key:
            return {}
        return {
            "prompt_cache_key": cache_key,
        }

    if provider == "anthropic":
        ttl = str(prompt_metadata.get("provider_cache_ttl", "") or "").strip().lower()
        cache_control: dict[str, Any] = {"type": "ephemeral"}
        if ttl == "1h":
            cache_control["ttl"] = "1h"
        return {"cache_control": cache_control}

    if provider == "google_genai":
        if not allow_google_explicit_cache:
            return {}
        # Gemini implicit caching is automatic; explicit cache references require
        # a provider-generated cached content resource name.
        cached_content = str(prompt_metadata.get("gemini_cached_content", "") or "").strip()
        if not cached_content and cache_key.startswith("cachedContents/"):
            cached_content = cache_key
        if cached_content:
            return {"cached_content": cached_content}
        return {}

    return {}


def _provider_cache_active_for_run(
    settings: Settings,
    *,
    provider: str,
    prompt_metadata: dict[str, Any],
    provider_cache_invoke_kwargs: dict[str, Any],
) -> bool:
    if not settings.provider_cache_enabled or not settings.prompt_cache_enabled:
        return False

    if not bool(prompt_metadata.get("provider_cache_eligible", False)):
        return False

    cache_mode = str(prompt_metadata.get("cache_mode", "") or "").strip().lower()
    if cache_mode not in {"provider_hook", "provider_active"}:
        return False

    if provider in {"openrouter", "openai", "anthropic"}:
        return bool(provider_cache_invoke_kwargs)

    if provider == "google_genai":
        # Gemini 2.5+ implicit caching is provider-managed and active by default
        # for sufficiently large shared prefixes.
        return True

    return bool(provider_cache_invoke_kwargs)


def _tool_cache_key(tool_name: str, tool_args: dict[str, Any]) -> str:
    payload = json.dumps(tool_args or {}, sort_keys=True, default=str)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"{tool_name}:{digest}"


def _is_tool_cache_eligible(tool_name: str) -> bool:
    return tool_name in {
        "get_page_context",
        "query_elements",
        "get_element_detail",
        "get_frame_tree",
        "get_media_state",
        "inspect",
        "inspect_landing",
        "inspect_hosting",
        "inspect_embedded",
    }


def _extract_retry_seconds(error_text: str) -> int | None:
    """Best-effort parsing of retry delay hints from provider error text."""
    if not error_text:
        return None
    match = re.search(r"retry in\s+([0-9]+(?:\.[0-9]+)?)s", error_text, flags=re.IGNORECASE)
    if match:
        try:
            return int(float(match.group(1)))
        except ValueError:
            return None
    match = re.search(r"'retryDelay'\s*:\s*'([0-9]+)s'", error_text)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    return None


def _assert_not_cancelled(observer: RunObserver | None, phase: str) -> None:
    if observer is None or not observer.is_cancel_requested():
        return

    reason = observer.cancel_reason() or "Cancelled from the control room."
    observer.emit(
        "run_cancelled",
        f"Run cancelled during {phase}",
        status="warning",
        details={"phase": phase, "cancel_reason": reason},
    )
    raise RunCancelledError(reason)


def _last_ai_message(messages: list[BaseMessage]) -> AIMessage | None:
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            return message
    return None


def _serialize_tool_output(raw: Any) -> str:
    if isinstance(raw, str):
        return raw
    if raw is None:
        return json.dumps({})
    return json.dumps(raw, default=str)


async def _invoke_tool(tool: BaseTool, tool_args: dict[str, Any]) -> Any:
    """Invoke a tool in the most compatible async-safe way possible."""
    try:
        return await tool.ainvoke(tool_args)
    except (AttributeError, NotImplementedError, TypeError):
        return await asyncio.to_thread(tool.invoke, tool_args)


_PROVIDER_CANONICAL = {
    "google": "google_genai",
    "openai": "openai",
    "anthropic": "anthropic",
    "openrouter": "openrouter",
}

_GEMINI_EXPLICIT_CACHE_REGISTRY: dict[str, dict[str, Any]] = {}
_GEMINI_EXPLICIT_CACHE_LOCK = Lock()
_GEMINI_EXPLICIT_CACHE_DEFAULT_TTL_SECONDS = 30 * 60
_GEMINI_EXPLICIT_CACHE_DEFAULT_REFRESH_LEAD_SECONDS = 2 * 60
_GEMINI_EXPLICIT_CACHE_MAX_ENTRIES = 256


def _parse_duration_seconds(value: Any) -> int:
    text = str(value or "").strip().lower()
    if not text:
        return 0
    if text.isdigit():
        return int(text)
    match = re.fullmatch(r"([0-9]+)\s*([smhd])", text)
    if not match:
        return 0
    amount = int(match.group(1))
    unit = match.group(2)
    factor = {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    return amount * factor


def _gemini_explicit_cache_ttl_seconds(settings: Settings, prompt_metadata: dict[str, Any]) -> int:
    ttl = _parse_duration_seconds(prompt_metadata.get("gemini_cache_ttl"))
    if ttl <= 0:
        ttl = _parse_duration_seconds(prompt_metadata.get("provider_cache_ttl"))
    if ttl <= 0:
        ttl = _to_int(prompt_metadata.get("gemini_cache_ttl_seconds"))
    if ttl <= 0:
        ttl = _to_int(getattr(settings, "gemini_explicit_cache_ttl_seconds", 0))
    if ttl <= 0:
        ttl = _GEMINI_EXPLICIT_CACHE_DEFAULT_TTL_SECONDS
    return max(ttl, 60)


def _gemini_explicit_cache_refresh_lead_seconds(settings: Settings, prompt_metadata: dict[str, Any], ttl_seconds: int) -> int:
    lead = _to_int(prompt_metadata.get("gemini_cache_refresh_lead_seconds"))
    if lead <= 0:
        lead = _to_int(getattr(settings, "gemini_explicit_cache_refresh_lead_seconds", 0))
    if lead <= 0:
        lead = min(_GEMINI_EXPLICIT_CACHE_DEFAULT_REFRESH_LEAD_SECONDS, max(ttl_seconds // 5, 30))
    return max(lead, 5)


def _is_gemini_explicit_cache_enabled(settings: Settings, prompt_metadata: dict[str, Any]) -> bool:
    if not settings.provider_cache_enabled or not settings.prompt_cache_enabled:
        return False
    if not bool(prompt_metadata.get("provider_cache_eligible", False)):
        return False
    cache_mode = str(prompt_metadata.get("cache_mode", "") or "").strip().lower()
    if cache_mode not in {"provider_hook", "provider_active"}:
        return False
    return bool(getattr(settings, "gemini_explicit_cache_enabled", True))


def _extract_gemini_cache_seed_text(system_prompt: str) -> str:
    text = str(system_prompt or "").strip()
    if not text:
        return ""
    marker = "\n\nTASK BRIEF\n"
    if marker in text:
        return text.split(marker, 1)[0].strip()
    return text


def _gemini_cache_registry_key(prompt_metadata: dict[str, Any], seed_text: str, model_name: str) -> str:
    provider_cache_key = str(prompt_metadata.get("provider_cache_key", "") or "").strip()
    if provider_cache_key:
        return f"{model_name}:{provider_cache_key}"
    digest = hashlib.sha256(seed_text.encode("utf-8")).hexdigest()[:24]
    return f"{model_name}:auto:{digest}"


def _normalize_gemini_model_name(model_name: str) -> str:
    model = str(model_name or "").strip()
    if not model:
        return ""
    if "/" in model and not model.startswith(("models/", "tunedModels/")):
        model = model.split("/", 1)[-1]
    if model.startswith(("models/", "tunedModels/")):
        return model
    return f"models/{model}"


def _parse_expire_epoch(expire_time: str) -> float | None:
    text = str(expire_time or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc).timestamp()
    except ValueError:
        return None


def _gemini_display_name(cache_key: str) -> str:
    digest = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()[:24]
    return f"owc-{digest}"


def _evict_gemini_cache_registry(now_epoch: float) -> None:
    stale_keys = [
        key
        for key, value in _GEMINI_EXPLICIT_CACHE_REGISTRY.items()
        if float(value.get("expires_at", 0) or 0) <= now_epoch
    ]
    for key in stale_keys:
        _GEMINI_EXPLICIT_CACHE_REGISTRY.pop(key, None)

    max_entries = max(_GEMINI_EXPLICIT_CACHE_MAX_ENTRIES, 8)
    if len(_GEMINI_EXPLICIT_CACHE_REGISTRY) <= max_entries:
        return

    ordered = sorted(
        _GEMINI_EXPLICIT_CACHE_REGISTRY.items(),
        key=lambda item: float(item[1].get("created_at", 0) or 0),
    )
    while len(ordered) > max_entries:
        oldest_key, _ = ordered.pop(0)
        _GEMINI_EXPLICIT_CACHE_REGISTRY.pop(oldest_key, None)


def _clear_managed_gemini_cache_registry_for_tests() -> None:
    with _GEMINI_EXPLICIT_CACHE_LOCK:
        _GEMINI_EXPLICIT_CACHE_REGISTRY.clear()


async def _create_gemini_cached_content_resource(
    *,
    api_key: str,
    model_name: str,
    cache_key: str,
    seed_text: str,
    ttl_seconds: int,
    timeout_seconds: int,
) -> tuple[str, float]:
    if not api_key:
        return "", 0.0

    model = _normalize_gemini_model_name(model_name)
    if not model or not seed_text:
        return "", 0.0

    payload = {
        "model": model,
        "displayName": _gemini_display_name(cache_key),
        "ttl": f"{ttl_seconds}s",
        "contents": [
            {
                "role": "user",
                "parts": [{"text": seed_text}],
            }
        ],
    }

    url = "https://generativelanguage.googleapis.com/v1beta/cachedContents"
    async with httpx.AsyncClient(timeout=max(timeout_seconds, 5)) as client:
        response = await client.post(url, params={"key": api_key}, json=payload)
        response.raise_for_status()
        data = response.json() if response.content else {}

    if not isinstance(data, dict):
        return "", 0.0

    cached_content = str(data.get("name", "") or "").strip()
    expires_at = _parse_expire_epoch(str(data.get("expireTime", "") or ""))
    if expires_at is None:
        expires_at = time.time() + ttl_seconds
    return cached_content, float(expires_at)


async def _resolve_managed_gemini_cached_content(
    settings: Settings,
    *,
    prompt_metadata: dict[str, Any],
    system_prompt: str,
    model_name: str,
    now_epoch: float | None = None,
) -> tuple[str, str]:
    cached_content = str(prompt_metadata.get("gemini_cached_content", "") or "").strip()
    if cached_content:
        return cached_content, "manual"

    provider_cache_key = str(prompt_metadata.get("provider_cache_key", "") or "").strip()
    if provider_cache_key.startswith("cachedContents/"):
        return provider_cache_key, "provider_key"

    if not _is_gemini_explicit_cache_enabled(settings, prompt_metadata):
        return "", "disabled"

    seed_text = _extract_gemini_cache_seed_text(system_prompt)
    min_chars = max(int(settings.prompt_cache_min_chars or 0), 0)
    if len(seed_text) < min_chars:
        return "", "seed_too_small"

    now = float(now_epoch if now_epoch is not None else time.time())
    ttl_seconds = _gemini_explicit_cache_ttl_seconds(settings, prompt_metadata)
    refresh_lead = _gemini_explicit_cache_refresh_lead_seconds(settings, prompt_metadata, ttl_seconds)
    cache_key = _gemini_cache_registry_key(prompt_metadata, seed_text, model_name)

    with _GEMINI_EXPLICIT_CACHE_LOCK:
        entry = _GEMINI_EXPLICIT_CACHE_REGISTRY.get(cache_key)
        if entry is not None:
            entry_name = str(entry.get("cached_content", "") or "").strip()
            expires_at = float(entry.get("expires_at", 0) or 0)
            if entry_name and (expires_at - now) > refresh_lead:
                return entry_name, "registry_hit"

    try:
        created_name, expires_at = await _create_gemini_cached_content_resource(
            api_key=settings.google_api_key,
            model_name=model_name,
            cache_key=cache_key,
            seed_text=seed_text,
            ttl_seconds=ttl_seconds,
            timeout_seconds=max(int(settings.tool_timeout_seconds or 30), 5),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Gemini explicit cache create/refresh failed for %s: %s", cache_key, exc)
        with _GEMINI_EXPLICIT_CACHE_LOCK:
            fallback = _GEMINI_EXPLICIT_CACHE_REGISTRY.get(cache_key)
            if fallback is not None:
                fallback_name = str(fallback.get("cached_content", "") or "").strip()
                fallback_expires = float(fallback.get("expires_at", 0) or 0)
                if fallback_name and fallback_expires > now:
                    return fallback_name, "fallback_after_error"
        return "", "create_failed"

    if not created_name:
        return "", "empty_resource"

    with _GEMINI_EXPLICIT_CACHE_LOCK:
        prior = _GEMINI_EXPLICIT_CACHE_REGISTRY.get(cache_key)
        _GEMINI_EXPLICIT_CACHE_REGISTRY[cache_key] = {
            "cached_content": created_name,
            "expires_at": expires_at,
            "created_at": now,
            "ttl_seconds": ttl_seconds,
        }
        _evict_gemini_cache_registry(now)
        return created_name, "created" if prior is None else "refreshed"


def build_llm(
    settings: Settings,
    temperature: float | None = None,
    model_override: str | None = None,
):
    """Build an LLM instance for the configured provider.

    Imports for non-default providers are deferred so that the container
    works with only langchain-google-genai installed (the default).
    """
    model_name = model_override or settings.agent_model
    temp = temperature if temperature is not None else settings.gemini_temperature
    provider = (settings.llm_provider or "google").lower()

    if provider == "openai":
        from langchain_openai import ChatOpenAI  # noqa: PLC0415
        return ChatOpenAI(
            model=model_name,
            api_key=settings.openai_api_key or None,
            temperature=temp,
        )

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic  # noqa: PLC0415
        return ChatAnthropic(
            model=model_name,
            api_key=settings.anthropic_api_key or None,
            temperature=temp,
        )

    if provider == "openrouter":
        from langchain_openai import ChatOpenAI  # noqa: PLC0415
        return ChatOpenAI(
            model=model_name,
            api_key=settings.openrouter_api_key or None,
            base_url=settings.openrouter_base_url,
            temperature=temp,
        )

    # default: google / gemini
    return ChatGoogleGenerativeAI(
        model=model_name,
        google_api_key=settings.google_api_key,
        temperature=temp,
        convert_system_message_to_human=True,
    )


async def run_agent_loop(
    settings: Settings,
    llm: Any,
    tools: list[BaseTool],
    system_prompt: str,
    initial_message: str,
    max_tool_calls: int = 20,
    budget_exhausted_message: str = "Budget exhausted. Output your final JSON now.",
    observer: RunObserver | None = None,
    run_name: str = "agent_loop",
    working_memory: "ShortTermMemory | None" = None,
    prompt_metadata: dict[str, Any] | None = None,
    turn_context_provider: Callable[[AgentGraphState], str] | None = None,
    bootstrap_url: str = "",
    bootstrap_context_first: bool = False,
    bootstrap_memory_lookup_first: bool = False,
    bootstrap_memory_page_type: str = "",
) -> AgentLoopResult:
    """Run an async LangGraph agent loop with structured tool calling."""
    prompt_meta = dict(prompt_metadata or {})
    tool_map: dict[str, BaseTool] = {tool.name: tool for tool in tools}
    llm_with_tools = llm.bind_tools(tools)
    # Support model name attribute differences across providers
    model_name = (
        getattr(llm, "model", None)
        or getattr(llm, "model_name", None)
        or ""
    )
    provider = _PROVIDER_CANONICAL.get(
        (settings.llm_provider or "google").lower(), "google_genai"
    )
    google_explicit_cache_compatible = True
    gemini_cached_content_source = "none"
    if provider == "google_genai":
        if tools:
            # Gemini cached_content cannot be combined with tool-enabled GenerateContent requests.
            google_explicit_cache_compatible = False
            gemini_cached_content_source = "disabled_with_tools"
            prompt_meta.pop("gemini_cached_content", None)
        else:
            managed_cached_content, gemini_cached_content_source = await _resolve_managed_gemini_cached_content(
                settings,
                prompt_metadata=prompt_meta,
                system_prompt=system_prompt,
                model_name=model_name,
            )
            if managed_cached_content:
                prompt_meta["gemini_cached_content"] = managed_cached_content

    pricing = resolve_model_pricing(settings, model_name=model_name, provider=provider)
    provider_cache_invoke_kwargs = _build_provider_cache_invoke_kwargs(
        settings,
        provider=provider,
        prompt_metadata=prompt_meta,
        allow_google_explicit_cache=google_explicit_cache_compatible,
    )
    provider_cache_active = _provider_cache_active_for_run(
        settings,
        provider=provider,
        prompt_metadata=prompt_meta,
        provider_cache_invoke_kwargs=provider_cache_invoke_kwargs,
    )
    tool_timeout_seconds = max(1, int(settings.tool_timeout_seconds))
    llm_timeout_seconds = max(5, tool_timeout_seconds * 3)
    tool_result_cache: dict[str, dict[str, Any]] = {}
    required_identical_observations = max(int(settings.tool_result_cache_min_identical_observations or 2), 2)
    tool_cache_hits = 0
    tool_cache_writes = 0
    llm_cache_hit_calls = 0
    llm_cached_input_tokens = 0
    llm_new_input_tokens = 0
    bootstrap_tool_calls = 0
    bootstrap_messages: list[BaseMessage] = []

    if observer is not None:
        observer.record_message("system")
        observer.record_message("human")
        observer.emit(
            "agent_loop_started",
            f"{run_name} started",
            details={
                "max_tool_calls": max_tool_calls,
                "model_name": model_name,
                "prompt": prompt_meta,
                "provider_cache_active": provider_cache_active,
                "gemini_cached_content_source": gemini_cached_content_source,
                "gemini_cached_content": str(prompt_meta.get("gemini_cached_content", "") or "")[:200],
                "tool_result_cache_enabled": bool(settings.tool_result_cache_enabled),
                "tool_result_cache_min_identical_observations": required_identical_observations,
                "bootstrap_url": bootstrap_url,
                "bootstrap_context_first": bootstrap_context_first,
                "bootstrap_memory_lookup_first": bootstrap_memory_lookup_first,
                "bootstrap_memory_page_type": str(bootstrap_memory_page_type or ""),
            },
        )

    async def _run_bootstrap_tool(tool_name: str, tool_args: dict[str, Any]) -> tuple[str, str]:
        nonlocal bootstrap_tool_calls
        tool = tool_map.get(tool_name)
        if tool is None:
            return "error", json.dumps({"error": f"Bootstrap tool not available: {tool_name}"})

        started_at = time.perf_counter()
        if observer is not None:
            observer.increment_tool_calls()
            observer.emit(
                "tool_call_started",
                f"Bootstrap calling {tool_name}",
                details={
                    "tool_name": tool_name,
                    "tool_args": tool_args,
                    "bootstrap": True,
                    "tool_call_number": bootstrap_tool_calls + 1,
                },
            )
            observer.record_message("tool")
        if working_memory is not None:
            working_memory.record_tool(tool_name, tool_args, status="started")

        try:
            raw = await asyncio.wait_for(
                _invoke_tool(tool, tool_args),
                timeout=tool_timeout_seconds,
            )
            result_content = _serialize_tool_output(raw)
            status = "success"
        except asyncio.TimeoutError:
            result_content = json.dumps(
                {
                    "error": f"Bootstrap tool '{tool_name}' timed out after {tool_timeout_seconds}s",
                }
            )
            status = "error"
        except Exception as exc:  # noqa: BLE001
            logger.warning("Bootstrap tool %s raised: %s", tool_name, exc)
            result_content = json.dumps({"error": str(exc)})
            status = "error"

        bootstrap_tool_calls += 1
        duration = round(time.perf_counter() - started_at, 3)
        if observer is not None:
            observer.emit(
                "tool_call_finished",
                f"Bootstrap {tool_name} completed",
                status=status,
                details={
                    "tool_name": tool_name,
                    "duration_seconds": duration,
                    "result_preview": result_content[:800],
                    "result_full": result_content,
                    "bootstrap": True,
                },
            )
        if working_memory is not None:
            working_memory.record_tool(
                tool_name,
                tool_args,
                status=status,
                result_preview=result_content[:400],
            )
            working_memory.ingest_tool_result(tool_name, tool_args, result_content)

        return status, result_content

    if bootstrap_url and bootstrap_memory_lookup_first and "memory_lookup" in tool_map:
        memory_lookup_args: dict[str, Any] = {"url": bootstrap_url}
        resolved_bootstrap_page_type = str(bootstrap_memory_page_type or "").strip()
        if resolved_bootstrap_page_type:
            memory_lookup_args["page_type"] = resolved_bootstrap_page_type

        status_mem, result_mem = await _run_bootstrap_tool("memory_lookup", memory_lookup_args)
        bootstrap_messages.append(
            HumanMessage(
                content=(
                    "BOOTSTRAP RESULT (memory_lookup):\n"
                    f"status={status_mem}\n"
                    f"payload={result_mem[:6000]}"
                )
            )
        )

    if bootstrap_url:
        nav_tool_name = "navigate" if "navigate" in tool_map else "open_url"
        status, result = await _run_bootstrap_tool(nav_tool_name, {"url": bootstrap_url})
        bootstrap_messages.append(
            HumanMessage(
                content=(
                    f"BOOTSTRAP RESULT ({nav_tool_name}):\n"
                    f"status={status}\n"
                    f"payload={result[:4000]}"
                )
            )
        )
        if bootstrap_context_first:
            context_tool_name = "get_page_context"
            context_args: dict[str, Any] = {"frame_path": "root"}
            for candidate in ("inspect", "inspect_landing", "inspect_hosting", "inspect_embedded"):
                if candidate in tool_map:
                    context_tool_name = candidate
                    context_args = {}
                    break

            status_ctx, result_ctx = await _run_bootstrap_tool(context_tool_name, context_args)
            bootstrap_messages.append(
                HumanMessage(
                    content=(
                        f"BOOTSTRAP RESULT ({context_tool_name}):\n"
                        f"status={status_ctx}\n"
                        f"payload={result_ctx[:6000]}"
                    )
                )
            )

    async def llm_node(state: AgentGraphState) -> dict[str, Any]:
        _assert_not_cancelled(observer, "agent loop")
        invocation_messages = list(state["messages"])
        turn_context = ""
        if turn_context_provider is not None:
            turn_context = str(turn_context_provider(state) or "").strip()
            if turn_context:
                invocation_messages.append(HumanMessage(content=turn_context))
        message_count = len(invocation_messages)
        with observability_span(
            f"{run_name}.llm_turn",
            kind="chain",
            input_value={
                "message_count": message_count,
                "tool_calls_made": state["tool_calls_made"],
            },
            attributes={
                "owc.run_name": run_name,
                "owc.message_count_before_call": message_count,
                "owc.tool_calls_made_before_call": state["tool_calls_made"],
            },
        ) as llm_span:
            if observer is not None:
                observer.emit(
                    "llm_turn_started",
                    "Calling model",
                    details={
                        "provider": provider,
                        "model_name": model_name,
                        "message_count": message_count,
                        "timeout_seconds": llm_timeout_seconds,
                        "provider_cache_active": provider_cache_active,
                        "gemini_cached_content_source": gemini_cached_content_source,
                    },
                )
            try:
                response: AIMessage = await asyncio.wait_for(
                    llm_with_tools.ainvoke(
                        invocation_messages,
                        config={"run_name": run_name},
                        **provider_cache_invoke_kwargs,
                    ),
                    timeout=llm_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                if observer is not None:
                    observer.emit(
                        "llm_timeout",
                        f"Model call timed out after {llm_timeout_seconds}s",
                        status="error",
                        details={
                            "provider": provider,
                            "model_name": model_name,
                            "message_count": message_count,
                            "timeout_seconds": llm_timeout_seconds,
                        },
                    )
                raise RuntimeError(f"LLM turn timed out after {llm_timeout_seconds}s") from exc
            except Exception as exc:
                error_text = str(exc)
                is_rate_limited = "RESOURCE_EXHAUSTED" in error_text or "429" in error_text
                if observer is not None:
                    if is_rate_limited:
                        observer.emit(
                            "llm_rate_limited",
                            "Provider quota exceeded for model call",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "retry_after_seconds": _extract_retry_seconds(error_text),
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                    else:
                        observer.emit(
                            "llm_error",
                            f"Model call failed: {type(exc).__name__}",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                raise
            usage = getattr(response, "usage_metadata", None)
            input_tokens, output_tokens = _extract_usage(usage)
            cache_metrics = _extract_cache_metrics(usage, response=response)
            nonlocal llm_cache_hit_calls, llm_cached_input_tokens, llm_new_input_tokens
            if cache_metrics["cache_hit"]:
                llm_cache_hit_calls += 1
            llm_cached_input_tokens += _to_int(cache_metrics.get("cached_input_tokens"))
            llm_new_input_tokens += _to_int(cache_metrics.get("new_input_tokens"))
            set_span_attributes(
                llm_span,
                {
                    "owc.model_name": model_name,
                    "owc.provider": provider,
                    "owc.input_tokens": input_tokens,
                    "owc.output_tokens": output_tokens,
                    "owc.cache_hit": bool(cache_metrics.get("cache_hit", False)),
                    "owc.cached_input_tokens": _to_int(cache_metrics.get("cached_input_tokens")),
                    "owc.new_input_tokens": _to_int(cache_metrics.get("new_input_tokens")),
                    "owc.tool_calls_requested": len(response.tool_calls or []),
                },
            )
            set_span_output(
                llm_span,
                {
                    "has_text": bool(response.content),
                    "tool_calls_requested": len(response.tool_calls or []),
                },
            )

        if observer is not None:
            observer.record_message("ai")
            usage_rollup = observer.add_llm_usage(
                getattr(response, "usage_metadata", None),
                model_name=model_name,
                provider=provider,
                pricing=pricing,
                response_metadata=getattr(response, "response_metadata", None),
                additional_kwargs=getattr(response, "additional_kwargs", None),
                cache_metrics=cache_metrics,
            )
            observer.emit(
                "llm_response",
                "Model responded",
                details={
                    "provider": provider,
                    "model_name": model_name,
                    "tool_calls": len(response.tool_calls or []),
                    "tool_call_names": [call.get("name", "") for call in (response.tool_calls or [])],
                    "tool_calls_payload": _json_ready(response.tool_calls or []),
                    "has_text": bool(response.content),
                    "message_count": message_count + 1,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "usage_metadata": _json_ready(getattr(response, "usage_metadata", None)),
                    "response_metadata": _json_ready(getattr(response, "response_metadata", None)),
                    "additional_kwargs": _json_ready(getattr(response, "additional_kwargs", None)),
                    "response_class": type(response).__name__,
                    "content_preview": (response.content or "")[:1200],
                    "content_full": response.content or "",
                    "prompt": prompt_meta,
                    "turn_context_preview": turn_context[:600],
                    "cache_hit": bool(cache_metrics.get("cache_hit", False)),
                    "cached_input_tokens": _to_int(cache_metrics.get("cached_input_tokens")),
                    "new_input_tokens": _to_int(cache_metrics.get("new_input_tokens")),
                    "provider_cache_active": provider_cache_active,
                    "gemini_cached_content_source": gemini_cached_content_source,
                    "estimated_input_cost_usd": float(usage_rollup.get("estimated_input_cost_usd", 0.0) or 0.0),
                    "estimated_output_cost_usd": float(usage_rollup.get("estimated_output_cost_usd", 0.0) or 0.0),
                    "estimated_total_cost_usd": float(usage_rollup.get("estimated_total_cost_usd", 0.0) or 0.0),
                    "cost_source": str(usage_rollup.get("cost_source", "") or "provider_pricing_catalog"),
                    "pricing": usage_rollup.get("pricing", {}),
                },
            )
        if working_memory is not None and response.content:
            working_memory.record_observation(
                str(response.content)[:500],
                source=f"{run_name}.llm",
            )

        return {"messages": [response], "budget_exhausted": False}

    async def tool_node(state: AgentGraphState) -> dict[str, Any]:
        nonlocal tool_cache_hits, tool_cache_writes
        _assert_not_cancelled(observer, "tool dispatch")
        response = _last_ai_message(state["messages"])
        if response is None or not response.tool_calls:
            return {}

        remaining_budget = state["max_tool_calls"] - state["tool_calls_made"]
        allowed_tool_calls = list(response.tool_calls[: max(remaining_budget, 0)])
        tool_messages: list[ToolMessage] = []
        tool_calls_made = state["tool_calls_made"]
        budget_exhausted = len(response.tool_calls) > len(allowed_tool_calls)

        for tc in allowed_tool_calls:
            tool_name: str = tc["name"]
            tool_args: dict[str, Any] = tc.get("args", {})
            tool_id: str = tc["id"]
            tool_calls_made += 1

            logger.debug(
                "Tool call [%d/%d]: %s(%s)",
                tool_calls_made,
                state["max_tool_calls"],
                tool_name,
                list(tool_args.keys()),
            )
            started_at = time.perf_counter()
            if observer is not None:
                observer.increment_tool_calls()
                observer.emit(
                    "tool_call_started",
                    f"Calling {tool_name}",
                    details={
                        "tool_name": tool_name,
                        "tool_args": tool_args,
                        "tool_call_number": tool_calls_made,
                        "tool_call_budget": state["max_tool_calls"],
                    },
                )
            if working_memory is not None:
                working_memory.record_tool(
                    tool_name,
                    tool_args,
                    status="started",
                )
                for key in ("url", "mainUrl", "player_iframe_url", "base_url"):
                    if tool_args.get(key):
                        working_memory.record_navigation(
                            str(tool_args[key]),
                            via=tool_name,
                        )

            with observability_span(
                tool_name,
                kind="tool",
                input_value=tool_args,
                attributes={
                    "tool.name": tool_name,
                    "owc.tool_call_number": tool_calls_made,
                    "owc.tool_call_budget": state["max_tool_calls"],
                },
            ) as tool_span:
                tool = tool_map.get(tool_name)
                cache_key = _tool_cache_key(tool_name, tool_args)
                cache_entry = tool_result_cache.get(cache_key)
                cache_hit = False
                cache_eligible = bool(settings.tool_result_cache_enabled) and _is_tool_cache_eligible(tool_name)
                if tool is None:
                    result_content = json.dumps({"error": f"Unknown tool: {tool_name}"})
                    tool_status = "error"
                else:
                    if (
                        cache_eligible
                        and cache_entry is not None
                        and cache_entry.get("cached_result")
                        and int(cache_entry.get("stable_observations", 0)) >= required_identical_observations
                    ):
                        result_content = str(cache_entry.get("cached_result"))
                        tool_status = "success"
                        cache_hit = True
                        tool_cache_hits += 1
                    else:
                        try:
                            try:
                                raw = await asyncio.wait_for(
                                    _invoke_tool(tool, tool_args),
                                    timeout=tool_timeout_seconds,
                                )
                                result_content = _serialize_tool_output(raw)
                                tool_status = "success"
                            except asyncio.TimeoutError:
                                result_content = json.dumps(
                                    {
                                        "error": (
                                            f"Tool '{tool_name}' timed out after {tool_timeout_seconds}s"
                                        )
                                    }
                                )
                                tool_status = "error"
                        except Exception as exc:
                            logger.warning("Tool %s raised: %s", tool_name, exc)
                            result_content = json.dumps({"error": str(exc)})
                            tool_status = "error"
                            set_span_attributes(
                                tool_span,
                                {
                                    "error.type": type(exc).__name__,
                                    "error.message": str(exc),
                                },
                            )

                        if cache_eligible and tool_status == "success":
                            if cache_entry is None:
                                cache_entry = {
                                    "last_output": result_content,
                                    "stable_observations": 1,
                                    "cached_result": "",
                                }
                                tool_result_cache[cache_key] = cache_entry
                            else:
                                if result_content == cache_entry.get("last_output"):
                                    cache_entry["stable_observations"] = int(cache_entry.get("stable_observations", 0)) + 1
                                else:
                                    cache_entry["last_output"] = result_content
                                    cache_entry["stable_observations"] = 1
                                    cache_entry["cached_result"] = ""
                            if int(cache_entry.get("stable_observations", 0)) >= required_identical_observations:
                                if cache_entry.get("cached_result") != result_content:
                                    tool_cache_writes += 1
                                cache_entry["cached_result"] = result_content
                                cache_entry["last_output"] = result_content

                tool_duration = round(time.perf_counter() - started_at, 3)
                set_span_attributes(
                    tool_span,
                    {
                        "owc.tool_status": tool_status,
                        "owc.tool_duration_seconds": tool_duration,
                        "owc.tool_cache_hit": cache_hit,
                    },
                )
                set_span_output(tool_span, result_content[:4000])

            tool_messages.append(ToolMessage(content=result_content, tool_call_id=tool_id))
            if observer is not None:
                observer.record_message("tool")
                observer.emit(
                    "tool_call_finished",
                    f"{tool_name} completed",
                    status=tool_status,
                    details={
                        "tool_name": tool_name,
                        "duration_seconds": tool_duration,
                        "result_preview": result_content[:800],
                        "result_full": result_content,
                        "message_count": len(state["messages"]) + len(tool_messages),
                        "cache_hit": cache_hit,
                        "cache_eligible": cache_eligible,
                    },
                )
            if working_memory is not None:
                working_memory.record_tool(
                    tool_name,
                    tool_args,
                    status=tool_status,
                    result_preview=result_content[:400],
                )
                working_memory.ingest_tool_result(tool_name, tool_args, result_content)

        return {
            "messages": tool_messages,
            "tool_calls_made": tool_calls_made,
            "budget_exhausted": budget_exhausted or tool_calls_made >= state["max_tool_calls"],
        }

    async def budget_exhausted_node(state: AgentGraphState) -> dict[str, Any]:
        logger.info("Budget exhausted (%d calls). Forcing final answer.", state["tool_calls_made"])
        if observer is not None:
            observer.emit(
                "budget_exhausted",
                "Tool-call budget exhausted; requesting final answer",
                status="warning",
                details={
                    "tool_calls_made": state["tool_calls_made"],
                    "max_tool_calls": state["max_tool_calls"],
                },
            )
            observer.record_message("human")

        budget_message = HumanMessage(content=budget_exhausted_message)
        _assert_not_cancelled(observer, "final answer preparation")
        with observability_span(
            f"{run_name}.final_answer",
            kind="chain",
            input_value={
                "message_count": len(state["messages"]) + 1,
                "tool_calls_made": state["tool_calls_made"],
            },
            attributes={
                "owc.run_name": run_name,
                "owc.tool_calls_made": state["tool_calls_made"],
                "owc.reason": "budget_exhausted",
            },
        ) as final_span:
            try:
                final: AIMessage = await asyncio.wait_for(
                    llm.ainvoke(
                        [*state["messages"], budget_message],
                        config={"run_name": f"{run_name}_final"},
                        **provider_cache_invoke_kwargs,
                    ),
                    timeout=llm_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                if observer is not None:
                    observer.emit(
                        "llm_timeout",
                        f"Final model call timed out after {llm_timeout_seconds}s",
                        status="error",
                        details={
                            "provider": provider,
                            "model_name": model_name,
                            "timeout_seconds": llm_timeout_seconds,
                            "phase": "budget_exhausted_final_answer",
                        },
                    )
                raise RuntimeError(f"Final LLM call timed out after {llm_timeout_seconds}s") from exc
            except Exception as exc:
                error_text = str(exc)
                is_rate_limited = "RESOURCE_EXHAUSTED" in error_text or "429" in error_text
                if observer is not None:
                    if is_rate_limited:
                        observer.emit(
                            "llm_rate_limited",
                            "Provider quota exceeded for final model call",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "retry_after_seconds": _extract_retry_seconds(error_text),
                                "phase": "budget_exhausted_final_answer",
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                    else:
                        observer.emit(
                            "llm_error",
                            f"Final model call failed: {type(exc).__name__}",
                            status="error",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "phase": "budget_exhausted_final_answer",
                                "error_type": type(exc).__name__,
                                "error_preview": error_text[:1200],
                            },
                        )
                raise
            final_usage = getattr(final, "usage_metadata", None)
            input_tokens, output_tokens = _extract_usage(final_usage)
            set_span_attributes(
                final_span,
                {
                    "owc.model_name": model_name,
                    "owc.provider": provider,
                    "owc.input_tokens": input_tokens,
                    "owc.output_tokens": output_tokens,
                },
            )
            set_span_output(final_span, (final.content or "")[:4000])

        if observer is not None:
            observer.record_message("ai")
            nonlocal llm_cache_hit_calls, llm_cached_input_tokens, llm_new_input_tokens
            final_cache_metrics = _extract_cache_metrics(getattr(final, "usage_metadata", None), response=final)
            if final_cache_metrics["cache_hit"]:
                llm_cache_hit_calls += 1
            llm_cached_input_tokens += _to_int(final_cache_metrics.get("cached_input_tokens"))
            llm_new_input_tokens += _to_int(final_cache_metrics.get("new_input_tokens"))
            usage_rollup = observer.add_llm_usage(
                getattr(final, "usage_metadata", None),
                model_name=model_name,
                provider=provider,
                pricing=pricing,
                response_metadata=getattr(final, "response_metadata", None),
                additional_kwargs=getattr(final, "additional_kwargs", None),
                cache_metrics=final_cache_metrics,
            )
            observer.emit(
                "llm_response",
                "Model responded",
                details={
                    "provider": provider,
                    "model_name": model_name,
                    "tool_calls": len(final.tool_calls or []),
                    "tool_call_names": [call.get("name", "") for call in (final.tool_calls or [])],
                    "tool_calls_payload": _json_ready(final.tool_calls or []),
                    "has_text": bool(final.content),
                    "message_count": len(state["messages"]) + 1,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "usage_metadata": _json_ready(getattr(final, "usage_metadata", None)),
                    "response_metadata": _json_ready(getattr(final, "response_metadata", None)),
                    "additional_kwargs": _json_ready(getattr(final, "additional_kwargs", None)),
                    "response_class": type(final).__name__,
                    "content_preview": (final.content or "")[:1200],
                    "content_full": final.content or "",
                    "prompt": prompt_meta,
                    "phase": "budget_exhausted_final_answer",
                    "cache_hit": bool(final_cache_metrics.get("cache_hit", False)),
                    "cached_input_tokens": _to_int(final_cache_metrics.get("cached_input_tokens")),
                    "new_input_tokens": _to_int(final_cache_metrics.get("new_input_tokens")),
                    "provider_cache_active": provider_cache_active,
                    "gemini_cached_content_source": gemini_cached_content_source,
                    "estimated_input_cost_usd": float(usage_rollup.get("estimated_input_cost_usd", 0.0) or 0.0),
                    "estimated_output_cost_usd": float(usage_rollup.get("estimated_output_cost_usd", 0.0) or 0.0),
                    "estimated_total_cost_usd": float(usage_rollup.get("estimated_total_cost_usd", 0.0) or 0.0),
                    "cost_source": str(usage_rollup.get("cost_source", "") or "provider_pricing_catalog"),
                    "pricing": usage_rollup.get("pricing", {}),
                },
            )

        return {"messages": [budget_message, final], "budget_exhausted": False}

    def route_after_llm(state: AgentGraphState) -> str:
        response = _last_ai_message(state["messages"])
        if response is None or not response.tool_calls:
            return "end"
        return "tools"

    def route_after_tools(state: AgentGraphState) -> str:
        return "budget_exhausted" if state.get("budget_exhausted", False) else "llm"

    graph = StateGraph(AgentGraphState)
    graph.add_node("llm", llm_node)
    graph.add_node("tools", tool_node)
    graph.add_node("budget_exhausted", budget_exhausted_node)
    graph.add_edge(START, "llm")
    graph.add_conditional_edges("llm", route_after_llm, {"tools": "tools", "end": END})
    graph.add_conditional_edges(
        "tools",
        route_after_tools,
        {"llm": "llm", "budget_exhausted": "budget_exhausted"},
    )
    graph.add_edge("budget_exhausted", END)
    compiled = graph.compile()

    initial_state: AgentGraphState = {
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=initial_message),
            *bootstrap_messages,
        ],
        "tool_calls_made": bootstrap_tool_calls,
        "max_tool_calls": max_tool_calls,
        "budget_exhausted": False,
    }

    context_metadata = {
        "actor": observer.actor if observer is not None else run_name,
        "run_name": run_name,
        "model_name": model_name,
        "provider": provider,
        "tool_names": list(tool_map.keys()),
        "max_tool_calls": max_tool_calls,
        "prompt": prompt_meta,
        "provider_cache_active": provider_cache_active,
    }
    context_tags = ["open-web-catcher", run_name, "agent-loop", "langgraph"]

    with using_observability_context(
        session_id=observer.run_id if observer is not None else "",
        metadata=context_metadata,
        tags=context_tags,
    ):
        with observability_span(
            run_name,
            kind="agent",
            input_value={"initial_message": initial_message},
            attributes={
                "owc.run_name": run_name,
                "owc.model_name": model_name,
                "owc.provider": provider,
                "owc.max_tool_calls": max_tool_calls,
                "owc.runtime": "langgraph",
            },
        ) as loop_span:
            final_state = await compiled.ainvoke(initial_state)
            messages = list(final_state["messages"])
            final_ai = _last_ai_message(messages)
            final_text = (
                final_ai.content
                if final_ai is not None and isinstance(final_ai.content, str)
                else str(final_ai.content) if final_ai is not None
                else ""
            )
            budget_was_exhausted = any(
                isinstance(message, HumanMessage) and message.content == budget_exhausted_message
                for message in messages[1:]
            )

            if observer is not None:
                observer.emit(
                    "agent_loop_finished",
                    f"{run_name} finished",
                    details={
                        "tool_calls_made": final_state["tool_calls_made"],
                        "message_count": len(messages),
                        "bootstrap_tool_calls": bootstrap_tool_calls,
                        "llm_cache_hit_calls": llm_cache_hit_calls,
                        "llm_cached_input_tokens": llm_cached_input_tokens,
                        "llm_new_input_tokens": llm_new_input_tokens,
                        "tool_cache_hits": tool_cache_hits,
                        "tool_cache_writes": tool_cache_writes,
                    },
                    status="warning" if budget_was_exhausted else "success",
                )

            set_span_output(
                loop_span,
                {
                    "tool_calls_made": final_state["tool_calls_made"],
                    "message_count": len(messages),
                    "bootstrap_tool_calls": bootstrap_tool_calls,
                    "final_text_preview": (final_text or "")[:2000],
                    "llm_cache_hit_calls": llm_cache_hit_calls,
                    "llm_cached_input_tokens": llm_cached_input_tokens,
                    "llm_new_input_tokens": llm_new_input_tokens,
                    "tool_cache_hits": tool_cache_hits,
                    "tool_cache_writes": tool_cache_writes,
                    "runtime": "langgraph",
                },
            )

    return AgentLoopResult(
        final_text=final_text or "",
        tool_calls_made=final_state["tool_calls_made"],
        messages=messages,
    )
