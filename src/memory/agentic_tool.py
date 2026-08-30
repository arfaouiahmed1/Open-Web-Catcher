"""Agentic ``memory_search`` tool (plan task 18, phase 2).

Replaces per-turn memory stuffing with an on-demand retrieval tool that is
registered on EVERY agent profile: :func:`build_memory_search_tool` produces a
LangChain tool appended to the MCP tool list in
:func:`src.tools.mcp_client.agent_tools`, so the LLM can query the pgvector
``site_hints`` store whenever it needs remembered playbooks instead of
receiving the whole context every turn.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

_MEMORY_SEARCH_DESCRIPTION = (
    "Search long-term site memory (remembered navigation playbooks, selectors, "
    "and route patterns) for the current or any domain. Use at run start or "
    "before repeating expensive exploration; returns ranked hint summaries."
)


class MemorySearchInput(BaseModel):
    """Arguments accepted by the ``memory_search`` tool."""

    query: str = Field(
        ...,
        description="What to look for, e.g. 'pagination pattern for match list' "
        "or 'player iframe selectors'. Include the domain when relevant.",
    )
    domain: str = Field(
        default="",
        description="Optional domain or URL to scope results to one site.",
    )
    page_type: str = Field(
        default="",
        description="Optional page type filter: landing_page | hosting_page | "
        "embedded_page | classification.",
    )
    limit: int = Field(
        default=6,
        ge=1,
        le=20,
        description="Maximum number of hints to return.",
    )


def build_memory_search_tool(session_factory: Any | None = None) -> StructuredTool:
    """Build the profile-agnostic ``memory_search`` LangChain tool.

    ``session_factory`` is injectable for tests; production opens a fresh
    ``SessionLocal`` session per invocation so no session is pinned.
    """
    from src.memory.hints_service import run_memory_search

    def _invoke(payload_kwargs: dict[str, Any]) -> str:
        return json.dumps(run_memory_search(**payload_kwargs), ensure_ascii=False)

    def _func(**kwargs: Any) -> str:
        if session_factory is not None:
            kwargs["session_factory"] = session_factory
        return _invoke(kwargs)

    async def _acoro(**kwargs: Any) -> str:
        if session_factory is not None:
            kwargs["session_factory"] = session_factory
        return await asyncio.to_thread(_invoke, kwargs)

    return StructuredTool.from_function(
        func=_func,
        coroutine=_acoro,
        name="memory_search",
        description=_MEMORY_SEARCH_DESCRIPTION,
        args_schema=MemorySearchInput,
    )
