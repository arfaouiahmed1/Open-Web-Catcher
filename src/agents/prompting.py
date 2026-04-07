"""Layered prompt compilation and caching for extraction agents."""

from __future__ import annotations

import hashlib
from threading import Lock
from typing import Any

from pydantic import BaseModel, Field

from src.utils.config import Settings

_ALLOWED_CACHE_MODES = {"app_only", "provider_hook", "provider_active"}
_STATIC_PROMPT_CACHE: dict[tuple[str, str, str, str, str], str] = {}
_CACHE_LOCK = Lock()


class CompiledPrompt(BaseModel):
    agent_id: str
    prompt_version: str
    prompt_hash: str
    compiled_prompt_hash: str
    cache_mode: str = "disabled"
    provider_cache_key: str = ""
    provider_cache_eligible: bool = False
    memory_injected: bool = False
    static_cache_hit: bool = False
    output_contract_version: str = "v1"
    sections: list[str] = Field(default_factory=list)
    content: str


def clear_prompt_cache() -> None:
    with _CACHE_LOCK:
        _STATIC_PROMPT_CACHE.clear()


def build_task_brief(
    *,
    url: str,
    page_type: str,
    run_goal: str,
    extras: dict[str, Any] | None = None,
) -> str:
    lines = [
        f"- target url: `{url}`",
        f"- page type: `{page_type}`",
        f"- run goal: {run_goal.strip()}",
    ]
    for key, value in (extras or {}).items():
        if value in (None, ""):
            continue
        label = str(key).replace("_", " ")
        lines.append(f"- {label}: `{value}`")
    return "\n".join(lines)


def build_runtime_context(*, tool_profile: str, max_tool_calls: int) -> str:
    return "\n".join(
        [
            f"- tool profile: `{tool_profile}`",
            f"- tool-call budget: `{max_tool_calls}`",
            "- rely on live page evidence and tool results, not assumptions",
        ]
    )


def compile_agent_prompt(
    *,
    settings: Settings,
    agent_id: str,
    base_policy: str,
    agent_contract: str,
    task_brief: str,
    memory_context: str = "",
    working_state: str = "",
    runtime_context: str = "",
    output_contract_version: str = "v1",
) -> CompiledPrompt:
    normalized_base = _normalize_block(base_policy)
    normalized_contract = _normalize_block(agent_contract)
    normalized_task = _normalize_block(task_brief)
    normalized_memory = _strip_heading(_normalize_block(memory_context), "SITE MEMORY HINTS")
    normalized_working_state = _strip_heading(_normalize_block(working_state), "WORKING STATE")
    normalized_runtime = _normalize_block(runtime_context)

    prompt_hash = _sha256(normalized_base)
    contract_hash = _sha256(normalized_contract)[:12] if normalized_contract else "none"
    runtime_hash = _sha256(normalized_runtime)[:12] if normalized_runtime else "none"
    memory_mode = "site_memory" if normalized_memory else "no_memory"
    cache_mode = _resolve_cache_mode(settings)

    static_cache_key = (
        agent_id,
        prompt_hash,
        memory_mode,
        output_contract_version,
        f"{contract_hash}:{runtime_hash}",
    )

    static_prefix = ""
    static_cache_hit = False
    if settings.prompt_cache_enabled:
        with _CACHE_LOCK:
            static_prefix = _STATIC_PROMPT_CACHE.get(static_cache_key, "")
            static_cache_hit = bool(static_prefix)
            if not static_prefix:
                static_prefix = _join_sections(
                    [
                        _render_section("BASE POLICY", normalized_base),
                        _render_section("AGENT CONTRACT", normalized_contract),
                        _render_section("RUNTIME CONTEXT", normalized_runtime),
                    ]
                )
                _STATIC_PROMPT_CACHE[static_cache_key] = static_prefix
    else:
        static_prefix = _join_sections(
            [
                _render_section("BASE POLICY", normalized_base),
                _render_section("AGENT CONTRACT", normalized_contract),
                _render_section("RUNTIME CONTEXT", normalized_runtime),
            ]
        )

    dynamic_sections = [
        _render_section("TASK BRIEF", normalized_task),
        _render_section("SITE MEMORY HINTS", normalized_memory),
        _render_section("WORKING STATE", normalized_working_state),
    ]
    content = _join_sections([static_prefix, *dynamic_sections])
    compiled_prompt_hash = _sha256(content)

    provider_cache_eligible = (
        cache_mode in {"provider_hook", "provider_active"}
        and len(static_prefix) >= max(int(settings.prompt_cache_min_chars or 0), 0)
    )
    provider_cache_key = (
        f"{agent_id}:{prompt_hash[:16]}:{output_contract_version}:{contract_hash}"
        if provider_cache_eligible
        else ""
    )

    sections = [
        section
        for section, value in (
            ("base_policy", normalized_base),
            ("agent_contract", normalized_contract),
            ("runtime_context", normalized_runtime),
            ("task_brief", normalized_task),
            ("site_memory_hints", normalized_memory),
            ("working_state", normalized_working_state),
        )
        if value
    ]

    return CompiledPrompt(
        agent_id=agent_id,
        prompt_version=f"{agent_id}:{prompt_hash[:12]}",
        prompt_hash=prompt_hash,
        compiled_prompt_hash=compiled_prompt_hash,
        cache_mode=cache_mode,
        provider_cache_key=provider_cache_key,
        provider_cache_eligible=provider_cache_eligible,
        memory_injected=bool(normalized_memory),
        static_cache_hit=static_cache_hit,
        output_contract_version=output_contract_version,
        sections=sections,
        content=content,
    )


def _resolve_cache_mode(settings: Settings) -> str:
    if not settings.prompt_cache_enabled:
        return "disabled"
    mode = str(settings.prompt_cache_mode or "provider_hook").strip().lower()
    return mode if mode in _ALLOWED_CACHE_MODES else "provider_hook"


def _normalize_block(value: str) -> str:
    return str(value or "").strip()


def _render_section(title: str, body: str) -> str:
    if not body:
        return ""
    return f"{title}\n{body}"


def _strip_heading(value: str, heading: str) -> str:
    if not value:
        return ""
    lines = value.splitlines()
    if lines and lines[0].strip().upper() == heading:
        return "\n".join(lines[1:]).strip()
    return value


def _join_sections(parts: list[str]) -> str:
    return "\n\n".join(part for part in parts if part)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
