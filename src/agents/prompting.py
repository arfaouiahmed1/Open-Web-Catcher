"""Layered prompt compilation and caching for extraction agents."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from threading import Lock
from typing import Any

from pydantic import BaseModel, Field

from src.utils.config import Settings

_ALLOWED_CACHE_MODES = {"app_only", "provider_hook", "provider_active"}
_STATIC_PROMPT_CACHE: dict[tuple[str, str, str, str, str], str] = {}
_CACHE_LOCK = Lock()

# {{include:...}} directives in prompt source resolve relative to this directory.
_PROMPT_DIR = Path("configs/prompts")

# Invariant: prompts carry {{budget}}, never literal numbers; resolved from these
# Settings attrs at compile time so text cannot drift from enforced tool-call limits.
_BUDGET_ATTR_BY_AGENT = {
    "classification": "classification_max_tool_calls",
    "landing_page": "landing_page_max_tool_calls",
    "hosting_page": "hosting_page_max_tool_calls",
    "embedded_page": "embedded_page_max_tool_calls",
}

_INCLUDE_RE = re.compile(r"\{\{include:([^}]+)\}\}")
_BUDGET_RE = re.compile(r"\{\{budget\}\}")


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


def expand_prompt_includes(
    text: str,
    *,
    base_dir: Path | None = None,
    _seen: frozenset[str] | None = None,
) -> str:
    """Expand ``{{include:name}}`` directives against ``base_dir`` (default _PROMPT_DIR).

    Includes may nest. Raises ValueError on missing files or include cycles so a
    broken prompt graph fails loudly at compile time instead of shipping stale text.
    """
    root = Path(base_dir) if base_dir is not None else _PROMPT_DIR
    seen = _seen if _seen is not None else frozenset()

    def _replace(match: re.Match[str]) -> str:
        name = match.group(1).strip()
        if name in seen:
            chain = " -> ".join((*sorted(seen), name))
            raise ValueError(f"prompt include cycle detected: {chain}")
        path = root / name
        if not path.is_file():
            raise ValueError(f"prompt include not found: {name} (looked for {path})")
        included = path.read_text(encoding="utf-8")
        return expand_prompt_includes(included, base_dir=root, _seen=seen | {name})

    return _INCLUDE_RE.sub(_replace, text)


def interpolate_prompt_budget(text: str, *, settings: Settings, agent_id: str) -> str:
    """Resolve {{budget}} placeholders from the per-agent Settings tool-call budget."""
    if not _BUDGET_RE.search(text):
        return text
    attr = _BUDGET_ATTR_BY_AGENT.get(agent_id)
    if attr is None:
        raise ValueError(f"no budget setting mapped for agent_id '{agent_id}'")
    budget = int(getattr(settings, attr))
    return _BUDGET_RE.sub(str(budget), text)


def prepare_prompt_source(*, text: str, settings: Settings, agent_id: str) -> str:
    """Compile-time prompt-source preparation: budget interpolation then includes."""
    prepared = interpolate_prompt_budget(text, settings=settings, agent_id=agent_id)
    return expand_prompt_includes(prepared)


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
    base_policy = prepare_prompt_source(text=base_policy, settings=settings, agent_id=agent_id)
    agent_contract = prepare_prompt_source(
        text=agent_contract, settings=settings, agent_id=agent_id
    )
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
