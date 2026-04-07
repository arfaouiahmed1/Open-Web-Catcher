"""Tests for layered prompt compilation and cache behavior."""

from __future__ import annotations

from src.agents.prompting import build_runtime_context, build_task_brief, clear_prompt_cache, compile_agent_prompt
from src.utils.config import Settings


def _settings(**overrides) -> Settings:
    return Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://localhost:9222",
        database_url="sqlite:///:memory:",
        memory_enabled=False,
        **overrides,
    )


def test_compile_agent_prompt_keeps_base_hash_stable_when_dynamic_layers_change():
    clear_prompt_cache()
    settings = _settings(prompt_cache_enabled=True, prompt_cache_mode="provider_hook", prompt_cache_min_chars=10)

    common = dict(
        settings=settings,
        agent_id="hosting_page",
        base_policy="Base policy line 1\nBase policy line 2",
        agent_contract="- final json required",
        runtime_context=build_runtime_context(tool_profile="hosting", max_tool_calls=20),
        output_contract_version="hosting-v1",
    )
    first = compile_agent_prompt(
        **common,
        task_brief=build_task_brief(
            url="https://example.com/watch/1",
            page_type="hosting_page",
            run_goal="Extract streams.",
        ),
        memory_context="SITE MEMORY HINTS\n- repeated server labels: `Server 2`",
        working_state="- current objective: Extract streams.",
    )
    second = compile_agent_prompt(
        **common,
        task_brief=build_task_brief(
            url="https://example.com/watch/2",
            page_type="hosting_page",
            run_goal="Extract streams from a different page.",
        ),
        memory_context="SITE MEMORY HINTS\n- repeated server labels: `Mirror`",
        working_state="- current objective: Try another server.",
    )

    assert first.prompt_hash == second.prompt_hash
    assert first.compiled_prompt_hash != second.compiled_prompt_hash


def test_compile_agent_prompt_includes_sections_in_order():
    clear_prompt_cache()
    settings = _settings()

    compiled = compile_agent_prompt(
        settings=settings,
        agent_id="landing_page",
        base_policy="Find hosting pages.",
        agent_contract="- return verified hosting pages only",
        task_brief=build_task_brief(
            url="https://example.com/live",
            page_type="landing_page",
            run_goal="Collect hosting page urls.",
        ),
        memory_context="Use remembered patterns carefully.",
        working_state="- current objective: collect links",
        runtime_context=build_runtime_context(tool_profile="landing", max_tool_calls=50),
    )

    content = compiled.content
    assert content.index("BASE POLICY") < content.index("AGENT CONTRACT")
    assert content.index("AGENT CONTRACT") < content.index("RUNTIME CONTEXT")
    assert content.index("RUNTIME CONTEXT") < content.index("TASK BRIEF")
    assert content.index("TASK BRIEF") < content.index("SITE MEMORY HINTS")
    assert content.index("SITE MEMORY HINTS") < content.index("WORKING STATE")


def test_compile_agent_prompt_uses_static_cache_and_provider_hook_threshold():
    clear_prompt_cache()
    settings = _settings(prompt_cache_enabled=True, prompt_cache_mode="provider_hook", prompt_cache_min_chars=20)

    kwargs = dict(
        settings=settings,
        agent_id="classification",
        base_policy="A" * 40,
        agent_contract="- output classification only",
        task_brief=build_task_brief(
            url="https://example.com",
            page_type="classification",
            run_goal="Classify the page.",
        ),
        memory_context="",
        working_state="",
        runtime_context=build_runtime_context(tool_profile="classification", max_tool_calls=5),
    )

    first = compile_agent_prompt(**kwargs)
    second = compile_agent_prompt(**kwargs)

    assert first.static_cache_hit is False
    assert second.static_cache_hit is True
    assert first.provider_cache_eligible is True
    assert first.provider_cache_key


def test_compile_agent_prompt_skips_provider_hook_when_prompt_cache_disabled():
    clear_prompt_cache()
    settings = _settings(prompt_cache_enabled=False)

    compiled = compile_agent_prompt(
        settings=settings,
        agent_id="embedded_page",
        base_policy="Extract streams.",
        agent_contract="- output final json",
        task_brief=build_task_brief(
            url="https://embed.example.com/player",
            page_type="embedded_page",
            run_goal="Extract embedded streams.",
        ),
        runtime_context=build_runtime_context(tool_profile="embedded", max_tool_calls=20),
    )

    assert compiled.cache_mode == "disabled"
    assert compiled.provider_cache_eligible is False
    assert compiled.provider_cache_key == ""
