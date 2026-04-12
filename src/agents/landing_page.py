"""Landing Page Agent."""

from __future__ import annotations

from pathlib import Path
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from src.agents.base import build_llm, run_agent_loop
from src.agents.memory import build_memory_context, remember_agent_run
from src.agents.prompting import build_runtime_context, build_task_brief, compile_agent_prompt
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.instrumentation import observability_span, set_span_output, using_observability_context
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/landing_page_v1.md")
_AGENT_CONTRACT = """\
- find and return hosting page URLs from the landing page
- use navigation and page-inspection tools as needed, but stay within budget
- respect the final JSON/output format defined in the base policy
- do not fabricate hosting links; only return verified live-page findings
"""


def _normalize_domain(url: str) -> str:
    host = (urlparse(str(url or "")).netloc or "").lower().strip()
    return host[4:] if host.startswith("www.") else host


def _generalize_url_pattern(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""

    parsed = urlparse(raw)
    if not parsed.scheme and not parsed.netloc:
        normalized = re.sub(r"\d+", "{n}", raw)
        normalized = re.sub(r"[0-9a-fA-F]{8,}", "{id}", normalized)
        return normalized

    path = parsed.path or "/"
    path = re.sub(r"/\d+(?=/|$)", "/{n}", path)
    path = re.sub(r"/[0-9a-fA-F]{8,}(?=/|$)", "/{id}", path)
    path = re.sub(r"/[A-Za-z0-9_-]{24,}(?=/|$)", "/{token}", path)

    query_pairs: list[tuple[str, str]] = []
    for key, value in parse_qsl(parsed.query or "", keep_blank_values=True):
        normalized_value = str(value)
        if re.fullmatch(r"\d+", normalized_value or ""):
            normalized_value = "{n}"
        elif re.fullmatch(r"[0-9a-fA-F]{8,}", normalized_value or ""):
            normalized_value = "{id}"
        elif len(normalized_value) >= 24 and re.fullmatch(r"[A-Za-z0-9_-]+", normalized_value):
            normalized_value = "{token}"
        query_pairs.append((key, normalized_value))

    query = urlencode(sorted(query_pairs), doseq=True)
    query = query.replace("%7B", "{").replace("%7D", "}")
    return urlunparse((parsed.scheme, _normalize_domain(raw), path, "", query, ""))


def _dedupe_keep_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        candidate = str(value or "").strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            result.append(candidate)
    return result


def _looks_like_low_value_url(url: str) -> bool:
    lowered = str(url or "").lower().strip()
    if not lowered:
        return True
    if lowered.startswith(("javascript:", "mailto:", "tel:")):
        return True
    if any(token in lowered for token in ("/privacy", "/terms", "/contact", "/about", "/login", "/register", "cdn-cgi")):
        return True
    if re.search(r"\.(css|js|png|jpe?g|gif|svg|ico|webp|pdf)(\?|$)", lowered):
        return True
    return False


def _hosting_prefix(url: str) -> str:
    parsed = urlparse(str(url or "").strip())
    segments = [segment for segment in parsed.path.split("/") if segment]
    if not segments:
        return ""
    # Use a broad stable bucket (first segment) to avoid overfitting dynamic slugs/tokens.
    return f"/{segments[0]}/"


def _normalize_pattern_signature(pattern: str) -> str:
    raw = str(pattern or "").strip().lower()
    if not raw:
        return ""
    return re.sub(r"\{[^}]+\}", "{}", raw)


def _normalize_hosting_pages(raw_pages: Any, *, source_url: str) -> list[dict[str, Any]]:
    if not isinstance(raw_pages, list):
        return []

    normalized: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for page in raw_pages:
        if isinstance(page, str):
            candidate_url = str(page).strip()
            page_dict: dict[str, Any] = {"url": candidate_url}
        elif isinstance(page, dict):
            candidate_url = str(page.get("url") or page.get("href") or "").strip()
            page_dict = dict(page)
            page_dict["url"] = candidate_url
        else:
            continue

        if not candidate_url.startswith(("http://", "https://")):
            continue
        if candidate_url in seen_urls:
            continue
        seen_urls.add(candidate_url)

        page_dict.setdefault("title", "")
        page_dict.setdefault("participants", "")
        page_dict.setdefault("channel", "")
        page_dict.setdefault("sport", "")
        page_dict.setdefault("league", "")
        page_dict.setdefault("status", "unknown")
        page_dict.setdefault("scheduled_time", "")
        page_dict.setdefault("confidence", 85)
        page_dict.setdefault("route", "embed_agent")
        page_dict.setdefault("entry_point", source_url)
        if not isinstance(page_dict.get("iframes"), list):
            page_dict["iframes"] = []

        patterns = page_dict.get("patterns") if isinstance(page_dict.get("patterns"), dict) else {}
        if not patterns.get("url_pattern"):
            patterns["url_pattern"] = _generalize_url_pattern(candidate_url)
        page_dict["patterns"] = patterns
        normalized.append(page_dict)

    return normalized


def _augment_landing_output(
    output_json: dict[str, Any],
    *,
    source_url: str,
    run_memory: dict[str, Any],
) -> tuple[dict[str, Any], int]:
    output = dict(output_json or {})
    hosting_pages = _normalize_hosting_pages(output.get("hosting_pages", []), source_url=source_url)
    existing_urls = {str(page.get("url") or "").strip() for page in hosting_pages}

    known_patterns: set[str] = set()
    known_pattern_signatures: set[str] = set()
    known_prefixes: set[str] = set()
    for page in hosting_pages:
        candidate_url = str(page.get("url") or "").strip()
        if candidate_url:
            generalized = _generalize_url_pattern(candidate_url)
            known_patterns.add(generalized)
            signature = _normalize_pattern_signature(generalized)
            if signature:
                known_pattern_signatures.add(signature)
            prefix = _hosting_prefix(candidate_url)
            if prefix:
                known_prefixes.add(prefix)

        patterns = page.get("patterns", {})
        if isinstance(patterns, dict):
            for key in ("url_pattern", "hosting_url_pattern"):
                value = str(patterns.get(key) or "").strip()
                if value:
                    known_patterns.add(value)
                    signature = _normalize_pattern_signature(value)
                    if signature:
                        known_pattern_signatures.add(signature)

    site_patterns = output.get("site_patterns", {})
    if isinstance(site_patterns, dict):
        remembered_hosting_pattern = str(site_patterns.get("hosting_url_pattern") or "").strip()
        if remembered_hosting_pattern:
            known_patterns.add(remembered_hosting_pattern)
            signature = _normalize_pattern_signature(remembered_hosting_pattern)
            if signature:
                known_pattern_signatures.add(signature)

    common_memory = run_memory.get("common", run_memory) if isinstance(run_memory, dict) else {}
    candidate_pool = _dedupe_keep_order(
        [
            *list(run_memory.get("hosting_candidate_urls", []) if isinstance(run_memory, dict) else []),
            *list(common_memory.get("critical_links", []) if isinstance(common_memory, dict) else []),
        ]
    )

    source_domain = _normalize_domain(source_url)
    expanded_count = 0
    for candidate_url in candidate_pool:
        if candidate_url in existing_urls:
            continue
        if not candidate_url.startswith(("http://", "https://")):
            continue
        if _normalize_domain(candidate_url) != source_domain:
            continue
        if _looks_like_low_value_url(candidate_url):
            continue

        candidate_pattern = _generalize_url_pattern(candidate_url)
        candidate_signature = _normalize_pattern_signature(candidate_pattern)
        candidate_prefix = _hosting_prefix(candidate_url)
        pattern_match = bool(candidate_pattern and candidate_pattern in known_patterns)
        signature_match = bool(candidate_signature and candidate_signature in known_pattern_signatures)
        prefix_match = bool(candidate_prefix and candidate_prefix in known_prefixes)
        if not (pattern_match or signature_match or (prefix_match and known_pattern_signatures)):
            continue

        existing_urls.add(candidate_url)
        expanded_count += 1
        hosting_pages.append(
            {
                "url": candidate_url,
                "title": "",
                "participants": "",
                "channel": "",
                "sport": "",
                "league": "",
                "status": "unknown",
                "scheduled_time": "",
                "confidence": 74,
                "classification_reason": "pattern-expanded from verified hosting candidate in this run",
                "servers": [],
                "iframes": [],
                "entry_point": source_url,
                "route": "embed_agent",
                "patterns": {
                    "url_pattern": candidate_pattern,
                },
            }
        )

    output["hosting_pages"] = hosting_pages

    extraction_summary = output.get("extraction_summary", {})
    if isinstance(extraction_summary, dict):
        extraction_summary["hosting_pages_found"] = len(hosting_pages)
        if "urls_crawled" in extraction_summary and isinstance(common_memory, dict):
            extraction_summary["urls_crawled"] = max(
                int(extraction_summary.get("urls_crawled") or 0),
                len(list(common_memory.get("critical_links", []))),
            )
        output["extraction_summary"] = extraction_summary

    if not isinstance(site_patterns, dict):
        site_patterns = {}
    if not site_patterns.get("hosting_url_pattern"):
        for pattern in known_patterns:
            if pattern:
                site_patterns["hosting_url_pattern"] = pattern
                break
    output["site_patterns"] = site_patterns

    output["pattern_expansion"] = {
        "expanded_candidates": expanded_count,
        "known_patterns": len([pattern for pattern in known_patterns if pattern]),
        "known_pattern_signatures": len([signature for signature in known_pattern_signatures if signature]),
        "candidate_pool_size": len(candidate_pool),
    }
    return output, expanded_count


class LandingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else "Explore the landing page and find all hosting page URLs."
        )

    async def run(
        self,
        url: str,
        observer: RunObserver | None = None,
        orchestrator_handoff: str = "",
    ) -> ExtractionResult:
        logger.info("LandingPageAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.LANDING_PAGE)
            observer.emit("agent_started", f"Landing page agent started for {url}")
            if orchestrator_handoff.strip():
                observer.emit(
                    "orchestrator_handoff_received",
                    "Landing agent received orchestrator guidance",
                    details={"handoff_preview": orchestrator_handoff[:800]},
                )

        with using_observability_context(
            session_id=observer.run_id if observer is not None else "",
            metadata={"agent_type": AgentType.LANDING_PAGE.value, "url": url},
            tags=["landing", "agent"],
        ):
            with observability_span(
                "landing_page_agent.run",
                kind="agent",
                input_value={"url": url},
                attributes={"owc.agent_type": AgentType.LANDING_PAGE.value},
            ) as span:
                short_memory = ShortTermMemory(
                    k=self.settings.memory_short_window,
                    page_type=AgentType.LANDING_PAGE.value,
                )
                memory_context = build_memory_context(
                    self.memory,
                    url=url,
                    page_type=AgentType.LANDING_PAGE.value,
                    prompt_limit=self.settings.memory_prompt_limit,
                    observer=observer,
                )
                compiled_prompt = compile_agent_prompt(
                    settings=self.settings,
                    agent_id=AgentType.LANDING_PAGE.value,
                    base_policy=self._system_prompt,
                    agent_contract=_AGENT_CONTRACT,
                    task_brief=build_task_brief(
                        url=url,
                        page_type=AgentType.LANDING_PAGE.value,
                        run_goal="Explore the landing page and identify hosting-page URLs that should be passed downstream.",
                        extras={
                            "orchestrator_handoff": orchestrator_handoff[:600] if orchestrator_handoff else "",
                        },
                    ),
                    memory_context=memory_context,
                    working_state=short_memory.working_state(
                        objective="Find hosting page URLs on the landing page.",
                        page_url=url,
                        page_type=AgentType.LANDING_PAGE.value,
                    ),
                    runtime_context=build_runtime_context(
                        tool_profile="landing",
                        max_tool_calls=self.settings.landing_page_max_tool_calls,
                    ),
                )
                if observer is not None:
                    observer.emit(
                        "prompt_compiled",
                        "Compiled layered prompt for landing page agent",
                        details=compiled_prompt.model_dump(exclude={"content"}),
                    )
                initial_message = f"Explore this landing page and find all hosting page URLs.\n\nmainUrl: {url}"
                if orchestrator_handoff.strip():
                    initial_message += (
                        "\n\nORCHESTRATOR HANDOFF\n"
                        f"{orchestrator_handoff}\n"
                        "Use this context as guidance and verify all findings with live tool evidence."
                    )
                async with agent_tools("landing", self.settings, observer=observer) as tools:
                    result = await run_agent_loop(
                        settings=self.settings,
                        llm=self.llm,
                        tools=tools,
                        system_prompt=compiled_prompt.content,
                        initial_message=initial_message,
                        max_tool_calls=self.settings.landing_page_max_tool_calls,
                        budget_exhausted_message="Budget exhausted. Output your final JSON now.",
                        observer=observer,
                        run_name="landing_page_agent",
                        working_memory=short_memory,
                        prompt_metadata=compiled_prompt.model_dump(exclude={"content"}),
                        turn_context_provider=lambda _state: short_memory.working_state(
                            objective="Find hosting page URLs on the landing page.",
                            page_url=url,
                            page_type=AgentType.LANDING_PAGE.value,
                        ),
                        bootstrap_url=url,
                        bootstrap_context_first=True,
                        bootstrap_memory_lookup_first=True,
                        bootstrap_memory_page_type=AgentType.LANDING_PAGE.value,
                    )

                output_json = result.parse_json()
                run_memory = short_memory.export_run_memory(page_type=AgentType.LANDING_PAGE.value)
                output_json, expanded_candidates = _augment_landing_output(
                    output_json,
                    source_url=url,
                    run_memory=run_memory,
                )
                hosting_pages = output_json.get("hosting_pages", [])
                extraction = ExtractionResult(
                    url=url,
                    page_type=PageType.LANDING,
                    status=ExtractionStatus.SUCCESS if hosting_pages else ExtractionStatus.FAILED,
                    agent_type=AgentType.LANDING_PAGE,
                    tool_calls_used=result.tool_calls_made,
                    metadata=output_json,
                )
                set_span_output(
                    span,
                    {
                        "hosting_pages_found": len(hosting_pages),
                        "pattern_expanded_candidates": expanded_candidates,
                        "status": extraction.status.value,
                        "tool_calls_used": result.tool_calls_made,
                    },
                )
                remember_agent_run(
                    self.memory,
                    url=url,
                    page_type=AgentType.LANDING_PAGE.value,
                    status=extraction.status.value,
                    payload=output_json,
                    observer=observer,
                    short_memory=short_memory,
                )

        if observer is not None:
            observer.emit(
                "agent_finished",
                f"Landing page agent found {len(hosting_pages)} hosting pages",
                status="success" if hosting_pages else "warning",
                details={
                    "hosting_pages_found": len(hosting_pages),
                    "pattern_expansion": extraction.metadata.get("pattern_expansion", {}),
                },
            )
        return extraction
