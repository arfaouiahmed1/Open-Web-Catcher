"""Shared LangGraph-based agent infrastructure."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from src.agents import cache as cache_helpers
from src.agents.cache import ToolResultCache
from src.agents.errors import BudgetExceededError, RunCancelledError
from src.llm.provider import ChatLiteLLM
from src.utils.config import Settings, resolve_agent_runtime_config
from src.utils.instrumentation import (
    observability_span,
    resolve_model_pricing,
    set_span_attributes,
    set_span_output,
    using_observability_context,
)
from src.utils.logging import get_logger
from src.utils.observability import RunObserver
from src.utils.provider_models import (
    normalize_gemini_model_id,
    provider_api_key,
    provider_base_url,
    resolve_google_model_runtime_profile,
    resolve_agent_model_selection,
    resolve_llm_tuning,
    resolve_model_context_window,
)

logger = get_logger(__name__)

if TYPE_CHECKING:
    from src.memory.short_term import ShortTermMemory


class AgentLoopResult:
    def __init__(
        self,
        final_text: str,
        tool_calls_made: int,
        messages: list[BaseMessage],
        *,
        bootstrap_tool_calls: int = 0,
        llm_tool_calls_made: int | None = None,
        stop_reason: str = "completed",
        budget_exhausted: bool = False,
        continuation_count: int = 0,
        continuation_capsules: list[dict[str, Any]] | None = None,
    ) -> None:
        self.final_text = final_text
        # Total tool calls, including bootstrap calls, for observability/reporting.
        self.tool_calls_made = tool_calls_made
        self.bootstrap_tool_calls = bootstrap_tool_calls
        self.llm_tool_calls_made = (
            tool_calls_made - bootstrap_tool_calls
            if llm_tool_calls_made is None
            else llm_tool_calls_made
        )
        self.messages = messages
        self.stop_reason = stop_reason
        self.budget_exhausted = budget_exhausted
        self.parse_error = ""
        self.continuation_count = max(0, int(continuation_count or 0))
        self.continuation_capsules = list(continuation_capsules or [])

    def parse_json(self) -> dict[str, Any]:
        """Parse a JSON object from Gemini output, including fenced/prose-wrapped JSON."""
        parsed, error = parse_json_object(self.final_text)
        self.parse_error = error
        if error:
            logger.warning("Could not parse agent output as JSON: %s", error)
        return parsed


def parse_json_object(text: str) -> tuple[dict[str, Any], str]:
    """Best-effort extraction of the first JSON object from LLM text."""
    raw = str(text or "").strip()
    if not raw:
        return {}, "empty_output"

    candidates = [raw]
    fenced = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", raw, flags=re.IGNORECASE | re.DOTALL)
    candidates.extend(item.strip() for item in fenced if item.strip())

    balanced = _extract_first_balanced_json_object(raw)
    if balanced:
        candidates.append(balanced)

    last_error = ""
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        payload, error = _try_load_json_object_candidate(candidate)
        if error:
            last_error = error
            continue
        if isinstance(payload, dict):
            return payload, ""
        last_error = f"json_root_not_object:{type(payload).__name__}"
    return {}, last_error or "no_json_object_found"


def _try_load_json_object_candidate(candidate: str) -> tuple[Any, str]:
    """Load JSON, with a narrow fallback for raw control chars in model output."""
    try:
        return json.loads(candidate), ""
    except json.JSONDecodeError as exc:
        first_error = f"json_decode_error:{exc.msg}"

    # Some providers occasionally emit visually valid JSON with a raw newline or
    # tab inside a key/value string. JSON forbids those control characters, but
    # removing them from the candidate preserves the object structure and avoids
    # discarding otherwise valid agent evidence.
    sanitized = re.sub(r"[\x00-\x1f]", "", candidate)
    if sanitized == candidate:
        return None, first_error
    try:
        return json.loads(sanitized), ""
    except json.JSONDecodeError as exc:
        return None, f"{first_error}; sanitized_json_decode_error:{exc.msg}"


def _extract_first_balanced_json_object(text: str) -> str:
    """Return the first balanced top-level JSON object substring, if present."""
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escape = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return text[start : index + 1]
        start = text.find("{", start + 1)
    return ""


class AgentGraphState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    tool_calls_made: int
    max_tool_calls: int
    budget_exhausted: bool
    stop_reason: str
    last_tool_batch_signature: str
    repeated_tool_batch_count: int
    no_progress_turn_count: int
    context_compaction_pending: bool
    context_usage_pct: float
    last_context_tokens: int
    continuation_index: int
    continuation_capsules: list[dict[str, Any]]
    last_low_specificity_query_signature: str
    repeated_low_specificity_query_count: int


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


def _truncate_for_capsule(value: Any, max_chars: int = 1200) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if len(text) <= max_chars:
            return text
        return f"{text[: max(0, max_chars - 3)].rstrip()}..."
    if isinstance(value, list):
        return [_truncate_for_capsule(item, max_chars=max_chars) for item in value[:24]]
    if isinstance(value, dict):
        return {
            str(key): _truncate_for_capsule(nested, max_chars=max_chars)
            for key, nested in list(value.items())[:40]
        }
    return value


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


def _extract_text_from_content(content: Any) -> str:
    """Extract plain text from an LLM content value (str or list of content blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return str(content) if content is not None else ""


def _extract_thinking_from_content(content: Any) -> str:
    """Extract Gemini thinking/reasoning text from content blocks."""
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("thought") and block.get("text"):
            parts.append(str(block["text"]))
    return "\n".join(parts)


def _extract_thinking_tokens(usage: Any, response_metadata: Any = None) -> int:
    """Extract Gemini thinking token counts from usage payloads."""
    usage_dict = usage if isinstance(usage, dict) else getattr(usage, "__dict__", {})
    val = usage_dict.get("thought_token_count") or usage_dict.get("thinking_token_count")
    if val:
        return _to_int(val)
    if response_metadata:
        meta = (
            response_metadata
            if isinstance(response_metadata, dict)
            else getattr(response_metadata, "__dict__", {})
        )
        for key in ("thought_token_count", "thinking_token_count"):
            if meta.get(key):
                return _to_int(meta[key])
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

    input_details = (
        payload_dict.get("input_token_details") or payload_dict.get("prompt_tokens_details") or {}
    )
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
        cache_creation_tokens = max(cache_creation_tokens, 0)

    return cached_tokens, cache_read_tokens, cache_creation_tokens


def _extract_cache_metrics(usage: Any, response: AIMessage | None = None) -> dict[str, Any]:
    usage_dict = usage if isinstance(usage, dict) else getattr(usage, "__dict__", {})
    response_metadata = (
        getattr(response, "response_metadata", None) if response is not None else None
    )
    additional_kwargs = (
        getattr(response, "additional_kwargs", None) if response is not None else None
    )
    response_dict = (
        response_metadata
        if isinstance(response_metadata, dict)
        else getattr(response_metadata, "__dict__", {})
    )
    kwargs_dict = (
        additional_kwargs
        if isinstance(additional_kwargs, dict)
        else getattr(additional_kwargs, "__dict__", {})
    )

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

    cached_tokens, cache_read_input_tokens, cache_creation_input_tokens = _extract_cache_counters(
        usage_dict
    )

    response_usage = response_dict.get("token_usage") if isinstance(response_dict, dict) else {}
    response_cached_tokens, response_cache_read, response_cache_creation = _extract_cache_counters(
        response_usage
    )
    cached_tokens = max(cached_tokens, response_cached_tokens)
    cache_read_input_tokens = max(cache_read_input_tokens, response_cache_read)
    cache_creation_input_tokens = max(cache_creation_input_tokens, response_cache_creation)

    kwargs_usage = (
        kwargs_dict.get("usage") or kwargs_dict.get("token_usage")
        if isinstance(kwargs_dict, dict)
        else {}
    )
    kwargs_cached_tokens, kwargs_cache_read, kwargs_cache_creation = _extract_cache_counters(
        kwargs_usage
    )
    cached_tokens = max(cached_tokens, kwargs_cached_tokens)
    cache_read_input_tokens = max(cache_read_input_tokens, kwargs_cache_read)
    cache_creation_input_tokens = max(cache_creation_input_tokens, kwargs_cache_creation)

    if cache_read_input_tokens:
        cached_tokens = max(cached_tokens, cache_read_input_tokens)
    cached_tokens = max(cached_tokens, 0)

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


def _looks_like_site_down_error(result_content: str) -> bool:
    text = str(result_content or "").lower()
    if not text:
        return False
    markers = (
        "site can't be reached",
        "err_name_not_resolved",
        "dns_probe_finished",
        "connection refused",
        "connection reset",
        "timed out",
        "503 service unavailable",
        "502 bad gateway",
        "504 gateway timeout",
        "net::err_",
    )
    return any(marker in text for marker in markers)


def _is_retryable_llm_error(exc: Exception) -> bool:
    error_text = str(exc or "").lower()
    retry_markers = (
        "503",
        "service unavailable",
        "resource_exhausted",
        "retrydelay",
        "rate limit",
        "temporarily unavailable",
        "connection reset",
        "connection aborted",
        "connection error",
        "remoteprotocolerror",
        "readtimeout",
        "connecttimeout",
        "internal server error",
        "deadline exceeded",
    )
    fatal_markers = (
        "invalid argument",
        "permission denied",
        "unauthenticated",
        "api key",
        "json",
        "schema",
    )
    if any(marker in error_text for marker in fatal_markers):
        return False
    return any(marker in error_text for marker in retry_markers)


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


def _summarize_memory_lookup_payload(raw: str) -> str:
    try:
        payload = json.loads(str(raw or ""))
    except Exception:
        return str(raw or "")[:2000]

    profile = payload.get("profile") if isinstance(payload, dict) else {}
    related_profiles = payload.get("related_profiles") if isinstance(payload, dict) else []
    profile = profile if isinstance(profile, dict) else {}
    related_profiles = related_profiles if isinstance(related_profiles, list) else []

    summary = {
        "ok": bool(payload.get("ok")) if isinstance(payload, dict) else False,
        "domain": str(payload.get("domain") or "") if isinstance(payload, dict) else "",
        "page_type": str(payload.get("page_type") or "") if isinstance(payload, dict) else "",
        "profile_found": bool(payload.get("profile_found")) if isinstance(payload, dict) else False,
        "memory_first_recommendation": str(payload.get("memory_first_recommendation") or "")[:300]
        if isinstance(payload, dict)
        else "",
        "profile_summary": {
            "revision": int(profile.get("revision") or 0) if profile else 0,
            "selectors": list(profile.get("selectors", [])[:6]) if profile else [],
            "url_patterns": list(profile.get("url_patterns", [])[:6]) if profile else [],
            "pagination_url_patterns": list(profile.get("pagination_url_patterns", [])[:4]) if profile else [],
            "server_labels": list(profile.get("server_labels", [])[:6]) if profile else [],
            "stream_hosts": list(profile.get("stream_hosts", [])[:6]) if profile else [],
            "ui_signals": list(profile.get("ui_signals", [])[:6]) if profile else [],
            "hosting_candidate_count": len(profile.get("hosting_candidate_urls", []) or []) if profile else 0,
            "has_navigation_hints": bool(profile.get("navigation_hints")) if profile else False,
            "has_critical_links": bool(profile.get("critical_links")) if profile else False,
            "memory_url_usage_rule": "use saved patterns/selectors as hints; do not navigate directly to remembered concrete URLs",
        },
        "related_profile_count": len(related_profiles),
    }
    return json.dumps(summary, ensure_ascii=False)


async def _invoke_tool(tool: BaseTool, tool_args: dict[str, Any]) -> Any:
    """Invoke a tool in the most compatible async-safe way possible."""
    try:
        return await tool.ainvoke(tool_args)
    except (AttributeError, NotImplementedError, TypeError):
        return await asyncio.to_thread(tool.invoke, tool_args)


def build_llm(
    settings: Settings,
    temperature: float | None = None,
    model_override: str | None = None,
    provider_override: str | None = None,
    agent_id: str | None = None,
):
    """Build the LiteLLM-backed chat model used by all agents.

    Model traffic routes through src/llm/provider.py; agents keep their
    LangChain call-sites. Legacy bare model names are prefixed for litellm
    routing at request time.
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
    model_name = model_override or selection_model or settings.agent_model
    if not model_name:
        # Last-resort fallback chain (legacy default + gemini_model).
        model_name = str(settings.agent_model or settings.gemini_model or "").strip()
    model_name = normalize_gemini_model_id(model_name)
    tuning = resolve_llm_tuning(
        settings,
        provider=provider_hint,
        model_name=model_name,
        agent_id=agent_id or "",
    )
    is_google = provider_hint == "google"
    if is_google:
        model_runtime_profile = resolve_google_model_runtime_profile(
            settings,
            model_id=model_name,
            provider="google",
        )
        allowed_tuning_keys = set(
            model_runtime_profile.get("allowed_tuning_keys")
            or {"top_p", "top_k", "max_output_tokens"}
        )
    else:
        model_runtime_profile = {
            "model_id": model_name,
            "resolved_from_catalog": False,
            "catalog_source": "non_google",
            "capabilities": {},
        }
        allowed_tuning_keys = {"temperature", "top_p", "max_tokens"}
    tuned_temperature = tuning.pop("temperature", None)
    if temperature is not None:
        temp = temperature
    elif tuned_temperature is not None:
        temp = tuned_temperature
    else:
        temp = settings.gemini_temperature

    llm_kwargs: dict[str, Any] = _filter_llm_kwargs(tuning, allowed_tuning_keys)
    if "max_output_tokens" in llm_kwargs:
        llm_kwargs["max_tokens"] = llm_kwargs.pop("max_output_tokens")
    thinking_budget = (
        settings.thinking_budget_tokens
        if settings.thinking_enabled
        and is_google
        and model_runtime_profile.get("supports_thinking_controls")
        else None
    )

    api_key = provider_api_key(settings, provider_hint) or None
    configured_provider_base = (getattr(settings, "provider_base_urls", {}) or {}).get(provider_hint, "")
    api_base = configured_provider_base or settings.llm_base_url or provider_base_url(settings, provider_hint) or None
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


def _filter_llm_kwargs(values: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if key in allowed and value is not None}


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
    working_memory: ShortTermMemory | None = None,
    prompt_metadata: dict[str, Any] | None = None,
    turn_context_provider: Callable[[AgentGraphState], str] | None = None,
    bootstrap_url: str = "",
    bootstrap_context_first: bool = False,
    bootstrap_memory_lookup_first: bool = False,
    bootstrap_memory_page_type: str = "",
    runtime_profile: str = "",
) -> AgentLoopResult:
    """Run an async LangGraph agent loop with structured tool calling."""
    prompt_meta = dict(prompt_metadata or {})
    tool_map: dict[str, BaseTool] = {tool.name: tool for tool in tools}
    llm_with_tools = llm.bind_tools(tools)
    # Gemini-only runtime. Keep canonical provider stable for metrics/caching.
    model_name = getattr(llm, "model", None) or getattr(llm, "model_name", None) or ""
    model_name = normalize_gemini_model_id(str(model_name or ""))
    configured_provider = str(settings.llm_provider or "litellm").strip().lower()
    if configured_provider not in {"google", "gemini", "google_genai", "litellm"}:
        logger.warning(
            "Ignoring unsupported LLM provider '%s'; routing through LiteLLM.",
            configured_provider,
        )
    provider = "google_genai"
    runtime_settings = resolve_agent_runtime_config(
        settings,
        runtime_profile or (observer.actor if observer is not None else run_name),
    )
    model_context_window = resolve_model_context_window(model_name, provider)
    normalized_runtime_profile = str(
        runtime_profile or runtime_settings.get("profile") or run_name or ""
    ).strip().lower()
    continuation_allowed = bool(
        getattr(settings, "context_continuation_enabled", True)
        and normalized_runtime_profile not in {"classification", "classification_agent"}
    )
    continuation_threshold = min(
        max(float(getattr(settings, "context_continuation_threshold", 0.8) or 0.8), 0.1),
        0.95,
    )
    max_continuations = max(0, int(getattr(settings, "context_continuation_max", 4) or 0))
    # LiteLLM response caching replaces the managed Gemini explicit-cache flow.
    provider_cache_active = bool(settings.prompt_cache_enabled)
    gemini_cached_content_source = "litellm" if provider_cache_active else "disabled"

    pricing = resolve_model_pricing(settings, model_name=model_name, provider=provider)
    tool_timeout_seconds = max(1, int(runtime_settings["tool_timeout_seconds"]))
    llm_timeout_seconds = max(5, int(runtime_settings["llm_turn_timeout_seconds"]))
    agent_timeout_seconds = max(30, int(runtime_settings["agent_timeout_seconds"]))
    llm_retry_attempts = max(1, int(runtime_settings["llm_retry_attempts"]))
    llm_retry_base_delay_seconds = max(
        0.0, float(runtime_settings["llm_retry_base_delay_seconds"])
    )
    llm_retry_max_delay_seconds = max(
        llm_retry_base_delay_seconds,
        float(runtime_settings["llm_retry_max_delay_seconds"]),
    )
    repeated_tool_call_limit = max(1, int(runtime_settings["repeated_tool_call_limit"]))
    no_progress_turn_limit = max(1, int(runtime_settings["no_progress_turn_limit"]))
    tool_cache = ToolResultCache(
        min_identical_observations=max(
            int(runtime_settings["tool_result_cache_min_identical_observations"] or 2),
            2,
        )
    )
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
                "provider": provider,
                "context_window": model_context_window,
                "prompt": prompt_meta,
                "provider_cache_active": provider_cache_active,
                "gemini_cached_content_source": gemini_cached_content_source,
                "gemini_cached_content": str(prompt_meta.get("gemini_cached_content", "") or "")[
                    :200
                ],
                "runtime_profile": runtime_settings["profile"],
                "tool_timeout_seconds": tool_timeout_seconds,
                "llm_turn_timeout_seconds": llm_timeout_seconds,
                "agent_timeout_seconds": agent_timeout_seconds,
                "llm_retry_attempts": llm_retry_attempts,
                "repeated_tool_call_limit": repeated_tool_call_limit,
                "no_progress_turn_limit": no_progress_turn_limit,
                "tool_result_cache_enabled": bool(settings.tool_result_cache_enabled),
                "tool_result_cache_min_identical_observations": tool_cache._min_obs,
                "bootstrap_url": bootstrap_url,
                "bootstrap_context_first": bootstrap_context_first,
                "bootstrap_memory_lookup_first": bootstrap_memory_lookup_first,
                "bootstrap_memory_page_type": str(bootstrap_memory_page_type or ""),
                "context_continuation_enabled": continuation_allowed,
                "context_continuation_threshold": continuation_threshold,
                "context_continuation_max": max_continuations,
            },
        )

    async def _run_bootstrap_tool(tool_name: str, tool_args: dict[str, Any]) -> tuple[str, str]:
        nonlocal bootstrap_tool_calls
        _assert_not_cancelled(observer, f"bootstrap {tool_name}")
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
                    "tool_call_id": f"bootstrap-{bootstrap_tool_calls + 1}",
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

        _assert_not_cancelled(observer, f"bootstrap {tool_name}")
        bootstrap_tool_calls += 1
        duration = round(time.perf_counter() - started_at, 3)
        if observer is not None:
            observer.emit(
                "tool_call_finished",
                f"Bootstrap {tool_name} completed",
                status=status,
                details={
                    "tool_call_id": f"bootstrap-{bootstrap_tool_calls}",
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

    if (
        bootstrap_url
        and bootstrap_memory_lookup_first
        and getattr(settings, "memory_enabled", True)
    ):
        # Plan task 18 phase 2 — hints are injected ONCE here at run start,
        # read straight from the pgvector site_hints store (this file is the
        # minimal-touch injection point; orchestrator.py stays untouched).
        # The legacy per-agent memory_lookup round-trip remains only as a
        # fallback when the store has nothing for this domain yet.
        resolved_bootstrap_page_type = str(bootstrap_memory_page_type or "").strip()
        run_start_hints = ""
        try:
            from src.memory.hints_service import build_run_start_hint_context

            run_start_hints = build_run_start_hint_context(
                bootstrap_url, resolved_bootstrap_page_type
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Run-start hint injection failed for %s: %s", bootstrap_url, exc)

        if run_start_hints:
            if observer is not None:
                observer.emit(
                    "run_start_hints_injected",
                    "Injected remembered site hints at run start",
                    details={
                        "url": bootstrap_url,
                        "page_type": resolved_bootstrap_page_type,
                        "hint_preview": run_start_hints[:600],
                        "source": "site_hints",
                    },
                )
            bootstrap_messages.append(
                HumanMessage(content=f"RUN-START SITE HINTS:\n{run_start_hints[:4000]}")
            )
        elif "memory_lookup" in tool_map:
            memory_lookup_args: dict[str, Any] = {"url": bootstrap_url}
            if resolved_bootstrap_page_type:
                memory_lookup_args["page_type"] = resolved_bootstrap_page_type

            status_mem, result_mem = await _run_bootstrap_tool("memory_lookup", memory_lookup_args)
            summarized_memory = _summarize_memory_lookup_payload(result_mem)
            bootstrap_messages.append(
                HumanMessage(
                    content=(
                        "BOOTSTRAP RESULT (memory_lookup):\n"
                        f"status={status_mem}\n"
                        f"payload={summarized_memory[:4000]}"
                    )
                )
            )

    if bootstrap_url:
        nav_tool_name = "navigate" if "navigate" in tool_map else "open_url"
        status, result = await _run_bootstrap_tool(nav_tool_name, {"url": bootstrap_url})
        bootstrap_messages.append(
            HumanMessage(
                content=(
                    f"BOOTSTRAP RESULT ({nav_tool_name}):\nstatus={status}\npayload={result[:4000]}"
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

    def _context_usage(input_tokens: int, output_tokens: int) -> tuple[int, float]:
        context_tokens = max(0, int(input_tokens or 0) + int(output_tokens or 0))
        window = int(model_context_window or 0)
        if window <= 0:
            return context_tokens, 0.0
        return context_tokens, context_tokens / max(window, 1)

    def _continuation_pending(
        *,
        input_tokens: int,
        output_tokens: int,
        state: AgentGraphState,
        response: AIMessage,
    ) -> tuple[bool, int, float]:
        context_tokens, usage_pct = _context_usage(input_tokens, output_tokens)
        if not continuation_allowed or max_continuations <= 0:
            return False, context_tokens, usage_pct
        if int(state.get("continuation_index", 0) or 0) >= max_continuations:
            return False, context_tokens, usage_pct
        if not response.tool_calls:
            return False, context_tokens, usage_pct
        return usage_pct >= continuation_threshold, context_tokens, usage_pct

    def _export_working_memory(page_type: str) -> dict[str, Any]:
        if working_memory is None or not hasattr(working_memory, "export_run_memory"):
            return {}
        try:
            value = working_memory.export_run_memory(page_type=page_type)
        except Exception:
            return {}
        return value if isinstance(value, dict) else {}

    def _build_continuation_capsule(
        state: AgentGraphState,
        *,
        continuation_index: int,
        reason: str,
    ) -> dict[str, Any]:
        page_type = str(bootstrap_memory_page_type or runtime_profile or run_name or "")
        working_state = ""
        if turn_context_provider is not None:
            try:
                working_state = str(turn_context_provider(state) or "").strip()
            except Exception:
                working_state = ""
        run_memory = _export_working_memory(page_type)
        common_memory = run_memory.get("common", run_memory) if isinstance(run_memory, dict) else {}
        if not isinstance(common_memory, dict):
            common_memory = {}
        remaining = max(int(state.get("max_tool_calls", 0) or 0) - int(state.get("tool_calls_made", 0) or 0), 0)
        capsule = {
            "objective": _truncate_for_capsule(initial_message, 1400),
            "target_url": bootstrap_url,
            "page_type": page_type,
            "actor": observer.actor if observer is not None else run_name,
            "run_name": run_name,
            "continuation_of_actor": observer.actor if observer is not None else run_name,
            "continuation_index": continuation_index,
            "compaction_reason": reason,
            "context_usage_pct": round(float(state.get("context_usage_pct", 0.0) or 0.0), 4),
            "context_tokens": int(state.get("last_context_tokens", 0) or 0),
            "context_window": int(model_context_window or 0),
            "tool_budget": {
                "used": int(state.get("tool_calls_made", 0) or 0),
                "total": int(state.get("max_tool_calls", 0) or 0),
                "remaining": remaining,
                "bootstrap_tool_calls": int(bootstrap_tool_calls or 0),
            },
            "visited_urls": _truncate_for_capsule(common_memory.get("critical_links", []), 220),
            "confirmed_patterns": _truncate_for_capsule(common_memory.get("url_patterns", []), 260),
            "confirmed_pagination": _truncate_for_capsule(common_memory.get("pagination_patterns", []), 260),
            "pending_frontier": _truncate_for_capsule(run_memory.get("hosting_candidate_urls", []), 260)
            if isinstance(run_memory, dict)
            else [],
            "server_evidence": _truncate_for_capsule(run_memory.get("server_records", []), 500)
            if isinstance(run_memory, dict)
            else [],
            "pending_server_frontier": _truncate_for_capsule(
                run_memory.get("server_frontier", []), 500
            )
            if isinstance(run_memory, dict)
            else [],
            "activation_targets": _truncate_for_capsule(
                run_memory.get("activation_targets", []), 320
            )
            if isinstance(run_memory, dict)
            else [],
            "observed_changes": _truncate_for_capsule(
                run_memory.get("observed_changes", []), 320
            )
            if isinstance(run_memory, dict)
            else [],
            "screenshots": _truncate_for_capsule(run_memory.get("server_screenshots", []), 260)
            if isinstance(run_memory, dict)
            else [],
            "streams": _truncate_for_capsule(run_memory.get("server_stream_urls", []), 260)
            if isinstance(run_memory, dict)
            else [],
            "blockers": _truncate_for_capsule(common_memory.get("blockers", []), 260),
            "next_best_move": _truncate_for_capsule(working_state, 6000),
            "working_state": _truncate_for_capsule(working_state, 6000),
        }
        return _json_ready(capsule)

    async def _invoke_llm_with_retries(
        invoke_coro: Callable[[], Any],
        *,
        phase: str,
        message_count: int,
    ) -> tuple[AIMessage, int]:
        last_exc: Exception | None = None
        for attempt in range(1, llm_retry_attempts + 1):
            _assert_not_cancelled(observer, phase)
            try:
                response: AIMessage = await asyncio.wait_for(
                    invoke_coro(),
                    timeout=llm_timeout_seconds,
                )
                return response, attempt
            except asyncio.TimeoutError as exc:
                last_exc = exc
                retryable = attempt < llm_retry_attempts
                if observer is not None and retryable:
                    delay = min(
                        llm_retry_max_delay_seconds,
                        llm_retry_base_delay_seconds * (2 ** (attempt - 1)),
                    )
                    observer.emit(
                        "llm_retry_scheduled",
                        f"Retrying model call after timeout ({attempt}/{llm_retry_attempts})",
                        status="warning",
                        details={
                            "provider": provider,
                            "model_name": model_name,
                            "phase": phase,
                            "attempt": attempt,
                            "max_attempts": llm_retry_attempts,
                            "message_count": message_count,
                            "timeout_seconds": llm_timeout_seconds,
                            "retry_delay_seconds": delay,
                            "reason": "timeout",
                            "context_window": model_context_window,
                        },
                    )
                    await asyncio.sleep(delay)
                    continue
                raise asyncio.TimeoutError(
                    f"LLM call timed out after {llm_timeout_seconds}s"
                ) from exc
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                retry_delay = _extract_retry_seconds(str(exc))
                retryable = _is_retryable_llm_error(exc) and attempt < llm_retry_attempts
                if retryable:
                    delay = float(
                        retry_delay
                        if retry_delay is not None
                        else min(
                            llm_retry_max_delay_seconds,
                            llm_retry_base_delay_seconds * (2 ** (attempt - 1)),
                        )
                    )
                    if observer is not None:
                        observer.emit(
                            "llm_retry_scheduled",
                            f"Retrying model call after provider failure ({attempt}/{llm_retry_attempts})",
                            status="warning",
                            details={
                                "provider": provider,
                                "model_name": model_name,
                                "phase": phase,
                                "attempt": attempt,
                                "max_attempts": llm_retry_attempts,
                                "message_count": message_count,
                                "retry_delay_seconds": delay,
                                "error_type": type(exc).__name__,
                                "error_preview": str(exc)[:1200],
                                "context_window": model_context_window,
                            },
                        )
                    await asyncio.sleep(delay)
                    continue
                raise
        raise last_exc or RuntimeError("LLM call failed")

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
                        "context_window": model_context_window,
                    },
                )
            try:
                response, attempt_count = await _invoke_llm_with_retries(
                    lambda: llm_with_tools.ainvoke(
                        invocation_messages,
                        config={"run_name": run_name},
                    ),
                    phase="llm_turn",
                    message_count=message_count,
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
                            "attempts": llm_retry_attempts,
                            "context_window": model_context_window,
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
                                "context_window": model_context_window,
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
                                "context_window": model_context_window,
                            },
                        )
                raise
            usage = getattr(response, "usage_metadata", None)
            input_tokens, output_tokens = _extract_usage(usage)
            context_tokens, context_usage_pct = _context_usage(input_tokens, output_tokens)
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
                    "owc.context_window": model_context_window,
                    "owc.context_tokens": context_tokens,
                    "owc.context_usage_pct": context_usage_pct,
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
                    "tool_call_names": [
                        call.get("name", "") for call in (response.tool_calls or [])
                    ],
                    "tool_calls_payload": _json_ready(response.tool_calls or []),
                    "has_text": bool(response.content),
                    "message_count": message_count + 1,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "context_window": model_context_window,
                    "context_tokens": context_tokens,
                    "context_usage_pct": context_usage_pct,
                    "usage_metadata": _json_ready(getattr(response, "usage_metadata", None)),
                    "response_metadata": _json_ready(getattr(response, "response_metadata", None)),
                    "additional_kwargs": _json_ready(getattr(response, "additional_kwargs", None)),
                    "response_class": type(response).__name__,
                    "content_preview": _extract_text_from_content(response.content)[:1200],
                    "content_full": _extract_text_from_content(response.content),
                    "thinking_content": _extract_thinking_from_content(response.content),
                    "thinking_tokens": _extract_thinking_tokens(
                        getattr(response, "usage_metadata", None),
                        getattr(response, "response_metadata", None),
                    ),
                    "prompt": prompt_meta,
                    "turn_context_preview": turn_context[:600],
                    "attempt_count": attempt_count,
                    "cache_hit": bool(cache_metrics.get("cache_hit", False)),
                    "cached_input_tokens": _to_int(cache_metrics.get("cached_input_tokens")),
                    "new_input_tokens": _to_int(cache_metrics.get("new_input_tokens")),
                    "cache_creation_input_tokens": _to_int(
                        cache_metrics.get("cache_creation_input_tokens")
                    ),
                    "provider_cache_active": provider_cache_active,
                    "gemini_cached_content_source": gemini_cached_content_source,
                    "estimated_input_cost_usd": float(
                        usage_rollup.get("estimated_input_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_cached_input_cost_usd": float(
                        usage_rollup.get("estimated_cached_input_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_cache_write_cost_usd": float(
                        usage_rollup.get("estimated_cache_write_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_output_cost_usd": float(
                        usage_rollup.get("estimated_output_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_total_cost_usd": float(
                        usage_rollup.get("estimated_total_cost_usd", 0.0) or 0.0
                    ),
                    "cost_source": str(
                        usage_rollup.get("cost_source", "") or "provider_pricing_catalog"
                    ),
                    "pricing": usage_rollup.get("pricing", {}),
                },
            )
        if working_memory is not None and response.content:
            working_memory.record_observation(
                _extract_text_from_content(response.content)[:500],
                source=f"{run_name}.llm",
            )

        pending, context_tokens, context_usage_pct = _continuation_pending(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            state=state,
            response=response,
        )
        return {
            "messages": [response],
            "budget_exhausted": False,
            "context_compaction_pending": pending,
            "context_usage_pct": context_usage_pct,
            "last_context_tokens": context_tokens,
        }

    def _low_specificity_query_signature(
        tool_name: str,
        tool_args: dict[str, Any],
    ) -> str:
        if tool_name != "query_elements":
            return ""
        specificity_keys = (
            "text_contains",
            "text_regex",
            "href_contains",
            "href_regex",
            "attr_name",
            "attr_value_contains",
            "attr_value_regex",
            "scope_node_id",
            "scope_element_ref",
            "scope_selector",
            "scope_xpath",
            "scope_text",
        )
        has_specificity = any(str(tool_args.get(key) or "").strip() for key in specificity_keys)
        attr = tool_args.get("attr")
        if isinstance(attr, dict) and any(str(value or "").strip() for value in attr.values()):
            has_specificity = True
        if has_specificity:
            return ""
        return json.dumps(
            {
                "tool_name": tool_name,
                "kind": str(tool_args.get("kind") or ""),
                "frame_path": str(tool_args.get("frame_path") or "root"),
                "limit": int(tool_args.get("limit") or 20),
            },
            sort_keys=True,
            default=str,
        )

    async def tool_node(state: AgentGraphState) -> dict[str, Any]:
        _assert_not_cancelled(observer, "tool dispatch")
        response = _last_ai_message(state["messages"])
        if response is None or not response.tool_calls:
            return {}

        remaining_budget = state["max_tool_calls"] - state["tool_calls_made"]
        allowed_tool_calls = list(response.tool_calls[: max(remaining_budget, 0)])
        tool_messages: list[ToolMessage] = []
        tool_calls_made = state["tool_calls_made"]
        budget_exhausted = len(response.tool_calls) > len(allowed_tool_calls)
        cache_hits_this_turn = 0
        state_mutated = False
        site_down_detected = False
        batch_signatures: list[str] = []
        last_low_specificity_query_signature = str(
            state.get("last_low_specificity_query_signature", "") or ""
        )
        repeated_low_specificity_query_count = int(
            state.get("repeated_low_specificity_query_count", 0) or 0
        )

        for tc in allowed_tool_calls:
            _assert_not_cancelled(observer, "tool dispatch")
            tool_name = str(tc.get("name", ""))
            raw_tool_args = tc.get("args", {})
            tool_args: dict[str, Any] = (
                dict(raw_tool_args) if isinstance(raw_tool_args, dict) else {}
            )
            tool_id = str(tc.get("id", ""))
            tool_calls_made += 1
            batch_signatures.append(
                json.dumps({"tool_name": tool_name, "tool_args": tool_args}, sort_keys=True, default=str)
            )
            low_specificity_query_signature = _low_specificity_query_signature(
                tool_name,
                tool_args,
            )
            if low_specificity_query_signature:
                repeated_low_specificity_query_count = (
                    repeated_low_specificity_query_count + 1
                    if low_specificity_query_signature == last_low_specificity_query_signature
                    else 1
                )
                last_low_specificity_query_signature = low_specificity_query_signature
                warning = (
                    "query_elements is being used as a broad read. Use current screenshot/context, "
                    "get_page_context, get_element_detail with a scope, navigate a representative "
                    "href, or final JSON instead."
                )
                if working_memory is not None:
                    working_memory.record_observation(warning, source="tool_guardrail")
                if observer is not None and repeated_low_specificity_query_count >= 2:
                    observer.emit(
                        "tool_guardrail_warning",
                        "Repeated low-specificity query_elements call",
                        status="warning",
                        details={
                            "tool_name": tool_name,
                            "tool_args": tool_args,
                            "repeat_count": repeated_low_specificity_query_count,
                            "recommended_next": (
                                "Use screenshot/context evidence, get_page_context, scoped "
                                "get_element_detail/query_elements, navigate, or final JSON."
                            ),
                        },
                    )
            else:
                repeated_low_specificity_query_count = 0

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
                        "tool_call_id": tool_id,
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
                cache_hit = False
                cache_status = "disabled"
                cache_eligible = bool(
                    settings.tool_result_cache_enabled
                ) and tool_cache.is_eligible(tool_name)
                if tool is None:
                    result_content = json.dumps({"error": f"Unknown tool: {tool_name}"})
                    tool_status = "error"
                else:
                    cached, cache_status = (
                        tool_cache.get(tool_name, tool_args) if cache_eligible else (None, "ineligible")
                    )
                    if cached is not None:
                        result_content = cached
                        tool_status = "success"
                        cache_hit = True
                        cache_hits_this_turn += 1
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
                            tool_cache.update(tool_name, tool_args, result_content)
                if tool_status == "success" and cache_helpers._is_state_mutating_tool(tool_name):
                    tool_cache.invalidate(reason=f"{tool_name}_success")
                    state_mutated = True
                if tool_status == "error" and _looks_like_site_down_error(result_content):
                    site_down_detected = True

                tool_duration = round(time.perf_counter() - started_at, 3)
                set_span_attributes(
                    tool_span,
                    {
                        "owc.tool_status": tool_status,
                        "owc.tool_duration_seconds": tool_duration,
                        "owc.tool_cache_hit": cache_hit,
                        "owc.tool_cache_generation": tool_cache.generation,
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
                        "tool_call_id": tool_id,
                        "tool_name": tool_name,
                        "duration_seconds": tool_duration,
                        "result_preview": result_content[:800],
                        "result_full": result_content,
                        "message_count": len(state["messages"]) + len(tool_messages),
                        "cache_hit": cache_hit,
                        "cache_eligible": cache_eligible,
                        "cache_status": cache_status,
                        "cache_generation": tool_cache.generation,
                        "cache_invalidations": tool_cache.invalidations,
                        "cache_last_invalidation_reason": tool_cache.last_invalidation_reason,
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

        batch_signature = "|".join(batch_signatures)
        repeated_tool_batch_count = (
            state.get("repeated_tool_batch_count", 0) + 1
            if batch_signature and batch_signature == state.get("last_tool_batch_signature", "")
            else 1
        )
        no_progress_turn_count = (
            state.get("no_progress_turn_count", 0) + 1
            if allowed_tool_calls and not state_mutated and cache_hits_this_turn == len(allowed_tool_calls)
            else 0
        )
        stop_reason = ""
        if site_down_detected:
            stop_reason = "site_down"
        elif repeated_tool_batch_count >= repeated_tool_call_limit:
            stop_reason = "no_progress"
        elif no_progress_turn_count >= no_progress_turn_limit:
            stop_reason = "no_progress"

        if stop_reason and observer is not None:
            observer.emit(
                "agent_stop_requested",
                f"{run_name} requested final answer due to {stop_reason.replace('_', ' ')}",
                status="warning",
                details={
                    "stop_reason": stop_reason,
                    "repeated_tool_batch_count": repeated_tool_batch_count,
                    "no_progress_turn_count": no_progress_turn_count,
                    "repeated_tool_call_limit": repeated_tool_call_limit,
                    "no_progress_turn_limit": no_progress_turn_limit,
                    "cache_hits_this_turn": cache_hits_this_turn,
                    "tool_calls_in_turn": len(allowed_tool_calls),
                },
            )

        return {
            "messages": tool_messages,
            "tool_calls_made": tool_calls_made,
            "budget_exhausted": budget_exhausted or tool_calls_made >= state["max_tool_calls"],
            "stop_reason": stop_reason,
            "last_tool_batch_signature": batch_signature,
            "repeated_tool_batch_count": repeated_tool_batch_count,
            "no_progress_turn_count": no_progress_turn_count,
            "last_low_specificity_query_signature": last_low_specificity_query_signature,
            "repeated_low_specificity_query_count": repeated_low_specificity_query_count,
        }

    async def compact_context_node(state: AgentGraphState) -> dict[str, Any]:
        continuation_index = int(state.get("continuation_index", 0) or 0) + 1
        reason = "context_window_threshold"
        capsule = _build_continuation_capsule(
            state,
            continuation_index=continuation_index,
            reason=reason,
        )
        usage_pct = float(state.get("context_usage_pct", 0.0) or 0.0)
        details = {
            "continuation_of_actor": observer.actor if observer is not None else run_name,
            "continuation_index": continuation_index,
            "compaction_reason": reason,
            "context_usage_pct": usage_pct,
            "context_tokens": int(state.get("last_context_tokens", 0) or 0),
            "context_window": int(model_context_window or 0),
            "continuation_capsule": capsule,
            "page_type": str(bootstrap_memory_page_type or runtime_profile or run_name or ""),
            "target_url": bootstrap_url,
            "tool_calls_made": int(state.get("tool_calls_made", 0) or 0),
            "max_tool_calls": int(state.get("max_tool_calls", 0) or 0),
        }
        if observer is not None:
            observer.emit(
                "context_compaction_started",
                f"Context reached {usage_pct * 100:.1f}%; compacting agent state",
                status="warning",
                details=details,
            )
            observer.emit(
                "agent_finished",
                "Agent invocation compacted for continuation",
                status="warning",
                details={
                    **details,
                    "stop_reason": "context_compacted",
                    "status": "partial",
                },
            )

        removals: list[RemoveMessage] = []
        for message in state.get("messages", []):
            message_id = getattr(message, "id", None)
            if message_id:
                removals.append(RemoveMessage(id=message_id))

        continuation_message = HumanMessage(
            content=(
                "CONTEXT CONTINUATION CAPSULE\n"
                f"{json.dumps(capsule, ensure_ascii=False, indent=2)}\n\n"
                "Continue exactly from `next_best_move`. Preserve completed evidence, "
                "do not repeat settled navigation unless live verification requires it, "
                "and keep using the remaining tool budget."
            )
        )
        next_messages: list[BaseMessage] = [
            *removals,
            SystemMessage(content=system_prompt),
            HumanMessage(content=initial_message),
            continuation_message,
        ]

        if observer is not None:
            observer.emit(
                "agent_started",
                f"Continuation invocation {continuation_index} started",
                details=details,
            )
            observer.emit(
                "context_compaction_finished",
                f"Continuation invocation {continuation_index} has compacted context",
                details={
                    **details,
                    "replacement_message_count": 3,
                    "removed_message_count": len(removals),
                },
            )

        return {
            "messages": next_messages,
            "context_compaction_pending": False,
            "continuation_index": continuation_index,
            "continuation_capsules": [
                *list(state.get("continuation_capsules", []) or []),
                capsule,
            ],
            "last_tool_batch_signature": "",
            "repeated_tool_batch_count": 0,
            "no_progress_turn_count": 0,
        }

    async def budget_exhausted_node(state: AgentGraphState) -> dict[str, Any]:
        stop_reason = str(state.get("stop_reason", "") or "")
        logger.info(
            "Finalizing agent loop (%d calls, reason=%s).",
            state["tool_calls_made"],
            stop_reason or "budget_exhausted",
        )
        if observer is not None:
            observer.emit(
                "budget_exhausted",
                (
                    "Stopping repeated tool loop; requesting final answer"
                    if stop_reason
                    else "Tool-call budget exhausted; requesting final answer"
                ),
                status="warning",
                details={
                    "tool_calls_made": state["tool_calls_made"],
                    "max_tool_calls": state["max_tool_calls"],
                    "stop_reason": stop_reason or "budget_exhausted",
                },
            )
            observer.record_message("human")

        final_context = ""
        if turn_context_provider is not None:
            final_context = str(turn_context_provider(state) or "").strip()
        budget_content = budget_exhausted_message
        if stop_reason == "no_progress":
            budget_content = (
                "Stop now. Recent tool turns are no longer producing new evidence. "
                "Use the current evidence and output the required final JSON."
            )
        elif stop_reason == "site_down":
            budget_content = (
                "Stop now. The target appears unavailable or unreachable from the collected evidence. "
                "Output the required final JSON using only the evidence gathered so far."
            )
        if final_context:
            budget_content += (
                "\n\nCURRENT WORKING STATE\n"
                f"{final_context}\n"
                "Use this state and the observed tool results to produce the required final output now."
            )
        budget_message = HumanMessage(content=budget_content)
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
                "owc.reason": stop_reason or "budget_exhausted",
            },
        ) as final_span:
            try:
                final, final_attempt_count = await _invoke_llm_with_retries(
                    lambda: llm.ainvoke(
                        [*state["messages"], budget_message],
                        config={"run_name": f"{run_name}_final"},
                    ),
                    phase="budget_exhausted_final_answer",
                    message_count=len(state["messages"]) + 1,
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
                            "attempts": llm_retry_attempts,
                            "context_window": model_context_window,
                        },
                    )
                raise RuntimeError(
                    f"Final LLM call timed out after {llm_timeout_seconds}s"
                ) from exc
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
                                "context_window": model_context_window,
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
                                "context_window": model_context_window,
                            },
                        )
                raise
            final_usage = getattr(final, "usage_metadata", None)
            input_tokens, output_tokens = _extract_usage(final_usage)
            context_tokens, context_usage_pct = _context_usage(input_tokens, output_tokens)
            set_span_attributes(
                final_span,
                {
                    "owc.model_name": model_name,
                    "owc.provider": provider,
                    "owc.input_tokens": input_tokens,
                    "owc.output_tokens": output_tokens,
                    "owc.context_window": model_context_window,
                    "owc.context_tokens": context_tokens,
                    "owc.context_usage_pct": context_usage_pct,
                },
            )
            set_span_output(final_span, (final.content or "")[:4000])

        if observer is not None:
            observer.record_message("ai")
            nonlocal llm_cache_hit_calls, llm_cached_input_tokens, llm_new_input_tokens
            final_cache_metrics = _extract_cache_metrics(
                getattr(final, "usage_metadata", None), response=final
            )
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
                    "attempt_count": final_attempt_count,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "context_window": model_context_window,
                    "context_tokens": context_tokens,
                    "context_usage_pct": context_usage_pct,
                    "usage_metadata": _json_ready(getattr(final, "usage_metadata", None)),
                    "response_metadata": _json_ready(getattr(final, "response_metadata", None)),
                    "additional_kwargs": _json_ready(getattr(final, "additional_kwargs", None)),
                    "response_class": type(final).__name__,
                    "content_preview": _extract_text_from_content(final.content)[:1200],
                    "content_full": _extract_text_from_content(final.content),
                    "thinking_content": _extract_thinking_from_content(final.content),
                    "thinking_tokens": _extract_thinking_tokens(
                        getattr(final, "usage_metadata", None),
                        getattr(final, "response_metadata", None),
                    ),
                    "prompt": prompt_meta,
                    "phase": "budget_exhausted_final_answer",
                    "cache_hit": bool(final_cache_metrics.get("cache_hit", False)),
                    "cached_input_tokens": _to_int(final_cache_metrics.get("cached_input_tokens")),
                    "new_input_tokens": _to_int(final_cache_metrics.get("new_input_tokens")),
                    "cache_creation_input_tokens": _to_int(
                        final_cache_metrics.get("cache_creation_input_tokens")
                    ),
                    "provider_cache_active": provider_cache_active,
                    "gemini_cached_content_source": gemini_cached_content_source,
                    "estimated_input_cost_usd": float(
                        usage_rollup.get("estimated_input_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_cached_input_cost_usd": float(
                        usage_rollup.get("estimated_cached_input_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_cache_write_cost_usd": float(
                        usage_rollup.get("estimated_cache_write_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_output_cost_usd": float(
                        usage_rollup.get("estimated_output_cost_usd", 0.0) or 0.0
                    ),
                    "estimated_total_cost_usd": float(
                        usage_rollup.get("estimated_total_cost_usd", 0.0) or 0.0
                    ),
                    "cost_source": str(
                        usage_rollup.get("cost_source", "") or "provider_pricing_catalog"
                    ),
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
        if (
            continuation_allowed
            and state.get("context_compaction_pending", False)
            and int(state.get("continuation_index", 0) or 0) < max_continuations
            and not state.get("stop_reason", "")
        ):
            return "compact_context"
        if state.get("budget_exhausted", False) or state.get("stop_reason", ""):
            return "budget_exhausted"
        return "llm"

    graph = StateGraph(AgentGraphState)
    graph.add_node("llm", llm_node)
    graph.add_node("tools", tool_node)
    graph.add_node("compact_context", compact_context_node)
    graph.add_node("budget_exhausted", budget_exhausted_node)
    graph.add_edge(START, "llm")
    graph.add_conditional_edges("llm", route_after_llm, {"tools": "tools", "end": END})
    graph.add_conditional_edges(
        "tools",
        route_after_tools,
        {"llm": "llm", "budget_exhausted": "budget_exhausted", "compact_context": "compact_context"},
    )
    graph.add_edge("compact_context", "llm")
    graph.add_edge("budget_exhausted", END)
    compiled = graph.compile()

    initial_state: AgentGraphState = {
        "messages": [
            SystemMessage(content=system_prompt),
            HumanMessage(content=initial_message),
            *bootstrap_messages,
        ],
        "tool_calls_made": 0,
        "max_tool_calls": max_tool_calls,
        "budget_exhausted": False,
        "stop_reason": "",
        "last_tool_batch_signature": "",
        "repeated_tool_batch_count": 0,
        "no_progress_turn_count": 0,
        "context_compaction_pending": False,
        "context_usage_pct": 0.0,
        "last_context_tokens": 0,
        "continuation_index": 0,
        "continuation_capsules": [],
        "last_low_specificity_query_signature": "",
        "repeated_low_specificity_query_count": 0,
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
            recursion_limit = max(25, (max_tool_calls + bootstrap_tool_calls + 3) * 4)
            graph_timeout_seconds = agent_timeout_seconds
            try:
                final_state = await asyncio.wait_for(
                    compiled.ainvoke(
                        initial_state,
                        config={"recursion_limit": recursion_limit},
                    ),
                    timeout=graph_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                if observer is not None:
                    observer.emit(
                        "agent_timeout",
                        f"{run_name} timed out after {graph_timeout_seconds}s",
                        status="error",
                        details={
                            "timeout_seconds": graph_timeout_seconds,
                            "max_tool_calls": max_tool_calls,
                            "bootstrap_tool_calls": bootstrap_tool_calls,
                            "recursion_limit": recursion_limit,
                            "runtime_profile": runtime_settings["profile"],
                        },
                    )
                raise RuntimeError(f"{run_name} timed out after {graph_timeout_seconds}s") from exc
            messages = list(final_state["messages"])
            final_ai = _last_ai_message(messages)
            final_text = (
                _extract_text_from_content(final_ai.content) if final_ai is not None else ""
            )
            budget_was_exhausted = any(
                isinstance(message, HumanMessage)
                and str(message.content or "").startswith(budget_exhausted_message)
                for message in messages[1:]
            )
            llm_tool_calls_made = int(final_state["tool_calls_made"])
            total_tool_calls_made = llm_tool_calls_made + bootstrap_tool_calls
            stop_reason = str(final_state.get("stop_reason", "") or "")
            if not stop_reason:
                stop_reason = "budget_exhausted" if budget_was_exhausted else "completed"

            if observer is not None:
                observer.emit(
                    "agent_loop_finished",
                    f"{run_name} finished",
                    details={
                        "tool_calls_made": total_tool_calls_made,
                        "llm_tool_calls_made": llm_tool_calls_made,
                        "message_count": len(messages),
                        "bootstrap_tool_calls": bootstrap_tool_calls,
                        "stop_reason": stop_reason,
                        "llm_cache_hit_calls": llm_cache_hit_calls,
                        "llm_cached_input_tokens": llm_cached_input_tokens,
                        "llm_new_input_tokens": llm_new_input_tokens,
                        "tool_cache_hits": tool_cache.hits,
                        "tool_cache_misses": tool_cache.misses,
                        "tool_cache_bypasses": tool_cache.bypasses,
                        "tool_cache_writes": tool_cache.writes,
                        "tool_cache_invalidations": tool_cache.invalidations,
                        "continuation_count": int(final_state.get("continuation_index", 0) or 0),
                        "continuation_capsules": final_state.get("continuation_capsules", []) or [],
                    },
                    status="warning" if stop_reason != "completed" else "success",
                )

            set_span_output(
                loop_span,
                {
                    "tool_calls_made": total_tool_calls_made,
                    "llm_tool_calls_made": llm_tool_calls_made,
                    "message_count": len(messages),
                    "bootstrap_tool_calls": bootstrap_tool_calls,
                    "stop_reason": stop_reason,
                    "final_text_preview": (final_text or "")[:2000],
                    "llm_cache_hit_calls": llm_cache_hit_calls,
                    "llm_cached_input_tokens": llm_cached_input_tokens,
                    "llm_new_input_tokens": llm_new_input_tokens,
                    "tool_cache_hits": tool_cache.hits,
                    "tool_cache_misses": tool_cache.misses,
                    "tool_cache_bypasses": tool_cache.bypasses,
                    "tool_cache_writes": tool_cache.writes,
                    "tool_cache_invalidations": tool_cache.invalidations,
                    "continuation_count": int(final_state.get("continuation_index", 0) or 0),
                    "runtime": "langgraph",
                },
            )

    return AgentLoopResult(
        final_text=final_text or "",
        tool_calls_made=total_tool_calls_made,
        llm_tool_calls_made=llm_tool_calls_made,
        bootstrap_tool_calls=bootstrap_tool_calls,
        stop_reason=stop_reason,
        budget_exhausted=budget_was_exhausted,
        messages=messages,
        continuation_count=int(final_state.get("continuation_index", 0) or 0),
        continuation_capsules=list(final_state.get("continuation_capsules", []) or []),
    )
