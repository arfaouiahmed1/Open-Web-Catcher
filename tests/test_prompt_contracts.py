"""Structural prompt-contract tests.

These tests assert schema-level rules about agent prompts and the compilation
machinery, never phrase strings from prompt prose:

- tool names mentioned in a prompt must exist in that profile's MCP registry;
- budgets must come from Settings via {{budget}} interpolation, never literals;
- shared extraction rules are deduplicated through the include mechanism;
- the classification output contract matches what _parse_output consumes;
- the fictional tool-driven orchestrator prompt stays deleted.
"""

import re
from pathlib import Path

import pytest

from src.agents.prompting import (
    clear_prompt_cache,
    compile_agent_prompt,
    expand_prompt_includes,
)
from src.models.enums import Confidence, PageType
from src.tools.mcp_client import REQUIRED_TOOLS_BY_PROFILE
from src.utils.config import Settings

PROMPT_DIR = Path(__file__).resolve().parents[1] / "configs" / "prompts"

PROFILE_BY_PROMPT = {
    "classification_v1.md": "classification",
    "landing_page_v1.md": "landing",
    "hosting_page_v1.md": "hosting",
    "embedded_page_v1.md": "embedded",
}

AGENT_ID_BY_PROMPT = {
    "classification_v1.md": "classification",
    "landing_page_v1.md": "landing_page",
    "hosting_page_v1.md": "hosting_page",
    "embedded_page_v1.md": "embedded_page",
}

BUDGET_ATTR_BY_AGENT_ID = {
    "classification": "classification_max_tool_calls",
    "landing_page": "landing_page_max_tool_calls",
    "hosting_page": "hosting_page_max_tool_calls",
    "embedded_page": "embedded_page_max_tool_calls",
}

ALL_REGISTERED_TOOLS = set().union(*REQUIRED_TOOLS_BY_PROFILE.values())
BACKTICKED_TOKEN_RE = re.compile(r"`([a-z][a-z0-9_]*)`")
HARDCODED_BUDGET_RE = re.compile(r"\b\d+\s+(?:tool calls?|total turns)\b", re.IGNORECASE)

SHARED_INCLUDE_NAME = "shared_extraction_rules.md"
# Sentences that exist ONLY inside the shared include file.
SHARED_BLOCK_MARKERS = (
    "Never reuse one server/source's played-video screenshot as evidence for another.",
    "Tokenized streams keep exact query strings and signed params.",
    '`visual_confirmation: "no video content"` only when no player/media evidence exists.',
)


def _prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


@pytest.mark.unit
def test_every_registered_tool_mentioned_in_a_prompt_is_in_that_profile() -> None:
    for name, profile in PROFILE_BY_PROMPT.items():
        tokens = set(BACKTICKED_TOKEN_RE.findall(_prompt(name)))
        mentioned_tools = tokens & ALL_REGISTERED_TOOLS
        unknown = mentioned_tools - REQUIRED_TOOLS_BY_PROFILE[profile]
        assert not unknown, f"{name} references tools missing from '{profile}' profile: {sorted(unknown)}"


@pytest.mark.unit
def test_each_profile_prompt_mentions_its_broad_inspect_tool() -> None:
    broad_tool_by_profile = {
        "classification_v1.md": "inspect",
        "landing_page_v1.md": "inspect_landing",
        "hosting_page_v1.md": "inspect_hosting",
        "embedded_page_v1.md": "inspect_embedded",
    }
    for name, tool in broad_tool_by_profile.items():
        assert tool in REQUIRED_TOOLS_BY_PROFILE[PROFILE_BY_PROMPT[name]]
        assert f"`{tool}`" in _prompt(name), name


@pytest.mark.unit
def test_no_hardcoded_budget_numbers_survive_in_prompt_files() -> None:
    for path in sorted(PROMPT_DIR.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        matches = HARDCODED_BUDGET_RE.findall(text)
        assert not matches, f"{path.name} hardcodes budgets: {matches}"


@pytest.mark.unit
def test_agent_prompts_carry_budget_placeholder_resolved_from_settings() -> None:
    settings = Settings()
    for name, agent_id in AGENT_ID_BY_PROMPT.items():
        assert "{{budget}}" in _prompt(name), name
        expected = getattr(settings, BUDGET_ATTR_BY_AGENT_ID[agent_id])
        compiled = compile_agent_prompt(
            settings=settings,
            agent_id=agent_id,
            base_policy=_prompt(name),
            agent_contract="- evidence only",
            task_brief="- target url: `https://example.test`",
        )
        assert "{{budget}}" not in compiled.content, name
        assert f"Budget: {expected} tool calls" in compiled.content, name


@pytest.mark.unit
def test_hosting_and_embedded_include_shared_extraction_rules_once() -> None:
    for name in ("hosting_page_v1.md", "embedded_page_v1.md"):
        assert f"{{{{include:{SHARED_INCLUDE_NAME}}}}}" in _prompt(name), name

    settings = Settings()
    clear_prompt_cache()
    compiled = compile_agent_prompt(
        settings=settings,
        agent_id="hosting_page",
        base_policy=_prompt("hosting_page_v1.md"),
        agent_contract="- evidence only",
        task_brief="- target url: `https://example.test`",
    )
    assert "{{include:" not in compiled.content
    for marker in SHARED_BLOCK_MARKERS:
        assert compiled.content.count(marker) == 1, marker
    expanded_tokens = set(BACKTICKED_TOKEN_RE.findall(compiled.content))
    shared_tools = expanded_tokens & ALL_REGISTERED_TOOLS
    assert not shared_tools - REQUIRED_TOOLS_BY_PROFILE["hosting"], sorted(
        shared_tools - REQUIRED_TOOLS_BY_PROFILE["hosting"]
    )


@pytest.mark.unit
def test_include_expansion_handles_nesting_cycles_and_missing_files(tmp_path: Path) -> None:
    (tmp_path / "a.md").write_text("A-start\n{{include:b.md}}\nA-end", encoding="utf-8")
    (tmp_path / "b.md").write_text("B-body", encoding="utf-8")
    expanded = expand_prompt_includes("x {{include:a.md}} y", base_dir=tmp_path)
    assert expanded == "x A-start\nB-body\nA-end y"

    (tmp_path / "loop1.md").write_text("{{include:loop2.md}}", encoding="utf-8")
    (tmp_path / "loop2.md").write_text("{{include:loop1.md}}", encoding="utf-8")
    with pytest.raises(ValueError, match="cycle"):
        expand_prompt_includes("{{include:loop1.md}}", base_dir=tmp_path)

    with pytest.raises(ValueError, match="not found"):
        expand_prompt_includes("{{include:does_not_exist.md}}", base_dir=tmp_path)


@pytest.mark.unit
def test_classification_output_contract_matches_parser_and_enums() -> None:
    text = _prompt("classification_v1.md").lower()
    assert "json" in text
    assert "no markdown fences" in text or "raw json" in text
    for page_type in PageType:
        assert f'"{page_type.value}"' in text, page_type.value
    for confidence in Confidence:
        assert f'"{confidence.value}"' in text, confidence.value
    for field in ("page_type", "confidence", "reasoning", "evidence", "anomalies", "next_steps", "tools_used"):
        assert f'"{field}"' in text, field


@pytest.mark.unit
def test_orchestrator_prompt_is_gone() -> None:
    assert not (PROMPT_DIR / "orchestrator_v1.md").exists()


@pytest.mark.unit
def test_prompts_are_engine_neutral() -> None:
    for name in PROFILE_BY_PROMPT:
        text = _prompt(name).lower()
        assert "puppeteer only" not in text, name
        assert "engine determined by server config" in text, name


@pytest.mark.unit
def test_prompts_state_react_loop_and_stop_conditions() -> None:
    for name in PROFILE_BY_PROMPT:
        text = _prompt(name)
        for token in ("OBSERVE", "STATE", "HYPOTHESIS", "ACTION", "VERIFY"):
            assert token in text, name
        assert "stop condition" in text.lower(), name


@pytest.mark.unit
def test_classification_parser_surfaces_dropped_fields() -> None:
    from src.agents.classification import _parse_output

    json_output = (
        '{"page_type": "hosting_page", "confidence": "high", '
        '"reasoning": "single watch target with server controls.", '
        '"evidence": ["player iframe returned by inspect"], '
        '"anomalies": ["discord popup dismissed"], '
        '"next_steps": "route to hosting agent", '
        '"tools_used": ["inspect", "interact"]}'
    )
    parsed = _parse_output(json_output, "https://example.test/watch")
    assert parsed.page_type == PageType.HOSTING
    assert parsed.confidence == Confidence.HIGH
    assert "EVIDENCE: player iframe returned by inspect" in parsed.reasoning
    assert "ANOMALIES: discord popup dismissed" in parsed.reasoning
    assert "NEXT_STEPS: route to hosting agent" in parsed.reasoning
    assert "TOOLS_USED: inspect, interact" in parsed.reasoning

    legacy_output = (
        "CLASSIFICATION: embed_video_page\n"
        "CONFIDENCE: medium\n\n"
        "REASONING:\nMinimal chrome around one player.\n\n"
        "ANOMALIES:\nNone detected\n"
    )
    legacy = _parse_output(legacy_output, "https://example.test/embed")
    assert legacy.page_type == PageType.EMBEDDED
    assert legacy.confidence == Confidence.MEDIUM
    assert "Minimal chrome around one player." in legacy.reasoning
