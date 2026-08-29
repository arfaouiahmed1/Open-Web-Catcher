"""Long-term site memory for cross-run extraction hints.

Plan task 18 phase 2: the legacy ``site_memory.db`` SQLite store and the JSON
profiles store are DECOMMISSIONED. :class:`LongTermMemory` keeps its public
surface (``remember``, ``build_prompt_context``) so orchestrator/agent call
sites stay untouched, but every read/write now flows through the relational
pgvector store (``site_hints`` via :class:`SiteHintRepository` /
:func:`src.memory.site_hint_writer.write_site_hint`). Historical rows were
imported into ``site_hints`` by alembic revision ``20260826_0022`` before the
old stores stopped being written.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from src.utils.logging import get_logger
from src.utils.observability import RunTrace

logger = get_logger(__name__)

_PROFILE_ARRAY_LIMITS = {
    "selectors": 32,
    "pagination_url_patterns": 16,
    "url_patterns": 32,
    "navigation_hints": 32,
    "critical_links": 120,
    "server_labels": 80,
    "stream_hosts": 60,
    "ui_signals": 24,
    "hosting_candidate_urls": 160,
    "server_records": 80,
    "server_screenshots": 60,
    "server_stream_urls": 160,
    "activated_servers": 80,
    "playbook_steps": 80,
    "rejected_patterns": 80,
    "failure_cues": 80,
    "pagination_rules": 48,
    "landing_match_urls": 160,
    "continuation_notes": 32,
}


def _coerce_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return _dedupe_keep_order([value])
    if isinstance(value, (list, tuple, set)):
        return _dedupe_keep_order([str(item) for item in value])
    return _dedupe_keep_order([str(value)])


def _normalize_domain(url: str) -> str:
    host = (urlparse(url).netloc or "").lower().strip()
    return host[4:] if host.startswith("www.") else host


def _dedupe_keep_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _format_memory_items(values: list[str], limit: int = 4) -> str:
    items = _dedupe_keep_order([str(value or "").strip() for value in values])[:limit]
    return ", ".join(f"`{item}`" for item in items) if items else "`none`"


def _looks_like_pagination_url(url: str) -> bool:
    candidate = str(url or "").lower()
    if not candidate:
        return False
    return bool(
        re.search(r"([?&](page|p|offset|start|cursor)=)|(/page/\d+)|(/p/\d+)|(-page-\d+)", candidate)
    )


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

    query_pairs = []
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
    normalized = urlunparse(
        (
            parsed.scheme,
            _normalize_domain(raw),
            path,
            "",
            query,
            "",
        )
    )
    return normalized


def _extract_urls_from_payload(value: Any, *, limit: int = 120) -> list[str]:
    urls: list[str] = []

    def _walk(node: Any) -> None:
        if len(urls) >= limit:
            return
        if isinstance(node, dict):
            for key, item in node.items():
                if len(urls) >= limit:
                    break
                if isinstance(item, str):
                    lowered = key.lower()
                    if lowered in {
                        "url",
                        "href",
                        "src",
                        "final_url",
                        "embedded_url",
                        "player_iframe_url",
                        "mainurl",
                        "source_url",
                    }:
                        urls.append(item)
                    elif lowered.endswith("_url") and item.startswith(("http://", "https://")):
                        urls.append(item)
                elif isinstance(item, (dict, list, tuple)):
                    _walk(item)
        elif isinstance(node, (list, tuple)):
            for item in node:
                if len(urls) >= limit:
                    break
                _walk(item)

    _walk(value)
    return _dedupe_keep_order([url for url in urls if url.startswith(("http://", "https://"))])


class LongTermMemory:
    """Stores reusable site-playbook hints across extraction runs.

    This is not classic RAG. It is a structured site-memory store backed by
    the pgvector ``site_hints`` table (one row per domain/page_type). The
    legacy ``site_memory.db`` / JSON-profile stores were decommissioned in
    plan task 18 phase 2; ``db_path``/``profiles_path`` are accepted for
    call-site compatibility and ignored.
    """

    def __init__(
        self,
        db_path: str = "data/site_memory.db",
        profiles_path: str | None = None,
        entry_ttl_days: int = 90,
    ) -> None:
        self._entry_ttl_days = max(int(entry_ttl_days or 90), 1)

    def remember(
        self,
        *,
        url: str,
        page_type: str,
        status: str,
        payload: dict[str, Any] | None = None,
        trace: RunTrace | None = None,
        actor: str = "",
        run_id: str = "",
        short_memory_summary: str = "",
    ) -> dict[str, Any]:
        data = build_site_memory_entry(
            url=url,
            page_type=page_type,
            status=status,
            payload=payload or {},
            trace=trace,
            actor=actor,
            short_memory_summary=short_memory_summary,
        )

        # Phase 2 write path: straight into the pgvector site_hints store.
        # The legacy sqlite insert + JSON profile refresh are gone; the single
        # (domain, page_type) hint row carries summary + playbook + selectors.
        try:
            from src.memory.site_hint_writer import write_site_hint
            from src.storage.database import SessionLocal

            session = SessionLocal()
            try:
                write_site_hint(
                    session,
                    domain=url,
                    page_type=page_type,
                    raw_entry=data,
                    ttl_days=self._entry_ttl_days,
                )
            finally:
                session.close()
        except Exception as exc:  # pragma: no cover - runtime safeguard
            logger.warning("Could not persist site hint for %s: %s", url, exc)

        return data

    def build_prompt_context(self, url: str, page_type: str, limit: int = 6) -> str:
        """Render remembered hints as a prompt block from ``site_hints``."""
        domain = _normalize_domain(url)
        if not domain:
            return ""

        try:
            from src.storage.database import SessionLocal
            from src.storage.repositories import SiteHintRepository
        except Exception:  # pragma: no cover - storage unavailable in tests
            return ""

        session = SessionLocal()
        try:
            repo = SiteHintRepository(session)
            records = repo.get_hints(domain=domain, page_type=page_type, limit=max(int(limit), 1))
            if not records:
                records = repo.get_hints(domain=domain, limit=max(int(limit), 4))
        except Exception as exc:  # pragma: no cover - runtime safeguard
            logger.warning("Could not load site hints for %s: %s", url, exc)
            return ""
        finally:
            session.close()

        if not records:
            return ""

        lines = [
            "SITE MEMORY PLAYBOOK",
            "Use as hints only; re-verify on the live page.",
            f"- scope: `{domain}` `{page_type}`; `{len(records)}` remembered hint(s)",
        ]
        for record in records:
            rate_pct = round(float(record.success_rate or 0.0) * 100)
            lines.append(
                f"- summary [{record.page_type}, success~{rate_pct}%]: "
                f"{(record.summary_text or '').strip()[:400]}"
            )
            steps = [str(step) for step in (record.navigation_steps or [])][:6]
            if steps:
                lines.append(
                    "- detailed playbook: "
                    + " -> ".join(f"`{step}`" for step in steps)
                )
            selectors = [str(item) for item in (record.selectors or [])][:5]
            if selectors:
                lines.append(
                    "- selectors/clicks: "
                    + _format_memory_items(selectors, 5)
                )
        lines.append("- policy: try remembered selectors/patterns first, then inspect if they fail")
        return "\n".join(lines)

    def close(self) -> None:
        """Maintained for backwards compatibility."""

def build_site_memory_entry(
    *,
    url: str,
    page_type: str,
    status: str,
    payload: dict[str, Any],
    trace: RunTrace | None,
    actor: str,
    short_memory_summary: str,
) -> dict[str, Any]:
    tool_sequence: list[str] = []
    tool_steps: list[str] = []
    navigation_targets: list[str] = []
    selectors: list[str] = []
    url_patterns: list[str] = []
    pagination_patterns: list[str] = []
    critical_links: list[str] = []
    llm_notes: list[str] = []
    hosting_candidate_urls: list[str] = []
    server_records: list[str] = []
    server_screenshots: list[str] = []
    server_stream_urls: list[str] = []
    activated_servers: list[str] = []
    playbook_steps: list[str] = []
    rejected_patterns: list[str] = []
    failure_cues: list[str] = []
    pagination_rules: list[str] = []
    landing_match_urls: list[str] = []
    continuation_notes: list[str] = []

    if trace is not None:
        scoped_events = [event for event in trace.events if not actor or event.actor == actor]
        for event in scoped_events:
            details = event.details or {}
            if event.kind == "tool_call_started":
                tool_name = str(details.get("tool_name", "") or "").strip()
                if tool_name:
                    tool_sequence.append(tool_name)
                args = details.get("tool_args", {}) or {}
                if tool_name:
                    step_target = ""
                    for key in (
                        "url",
                        "mainUrl",
                        "frame_path",
                        "kind",
                        "selector",
                        "xpath",
                        "text",
                        "action",
                        "mode",
                        "player_iframe_url",
                    ):
                        value = args.get(key)
                        if value:
                            step_target = f"{key}={value}"
                            break
                    tool_steps.append(f"{tool_name}({step_target})" if step_target else tool_name)
                    playbook_steps.append(
                        f"{event.seq}: {tool_name} used {step_target or 'no explicit target'}"
                    )
                for key in ("url", "mainUrl", "player_iframe_url", "base_url"):
                    if args.get(key):
                        candidate_url = str(args[key])
                        navigation_targets.append(f"{key}={candidate_url}")
                        if candidate_url.startswith(("http://", "https://")):
                            critical_links.append(candidate_url)
                            url_patterns.append(_generalize_url_pattern(candidate_url))
                            if _looks_like_pagination_url(candidate_url):
                                pagination_patterns.append(_generalize_url_pattern(candidate_url))
                for key in ("selector", "xpath", "text", "element_ref", "kind", "action", "player_iframe_hint"):
                    if args.get(key):
                        selectors.append(f"{key}={args[key]}")
            elif event.kind == "llm_response" and details.get("content_preview"):
                llm_notes.append(str(details["content_preview"])[:240])
            elif event.kind in {"context_compaction_started", "context_compaction_finished"}:
                continuation_notes.append(
                    json.dumps(
                        {
                            "seq": event.seq,
                            "kind": event.kind,
                            "usage": details.get("context_usage_pct"),
                            "reason": details.get("compaction_reason"),
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    )
                )

    servers = payload.get("servers", []) if isinstance(payload, dict) else []
    stream_urls: list[str] = []
    for entry in payload.get("streaming_urls", []) if isinstance(payload, dict) else []:
        if isinstance(entry, dict) and entry.get("url"):
            stream_urls.append(str(entry["url"]))
    for entry in payload.get("all_stream_urls", []) if isinstance(payload, dict) else []:
        if isinstance(entry, dict) and entry.get("url"):
            stream_urls.append(str(entry["url"]))
    for server in servers:
        if not isinstance(server, dict):
            continue
        for field in ("m3u8_urls", "mpd_urls", "mp4_urls"):
            values = server.get(field, []) or []
            if isinstance(values, list):
                stream_urls.extend([str(value) for value in values if value])
        primary_stream = str(server.get("primary_stream", "") or "").strip()
        if primary_stream:
            stream_urls.append(primary_stream)

        label = str(server.get("label", "") or "").strip()
        status_label = str(server.get("status", "") or "").strip().lower()
        player_state = str(server.get("player_state", "") or "").strip().lower()
        screenshot_url = str(server.get("screenshot_url", "") or "").strip()
        embedded_url = str(server.get("embedded_url", "") or "").strip()
        server_up = bool(server.get("server_up"))

        if screenshot_url:
            server_screenshots.append(screenshot_url)
        if label and (
            server_up
            or status_label in {"success", "partial", "active"}
            or player_state in {"playing", "loading", "ready"}
        ):
            activated_servers.append(label)

        server_specific_streams: list[str] = []
        for field in ("m3u8_urls", "mpd_urls", "mp4_urls"):
            values = server.get(field, []) or []
            if isinstance(values, list):
                server_specific_streams.extend([str(value) for value in values if value])
        if primary_stream:
            server_specific_streams.append(primary_stream)
        server_stream_urls.extend(_dedupe_keep_order(server_specific_streams))

        server_record = {
            "label": label,
            "status": status_label or ("success" if server_up else "unknown"),
            "player_state": player_state or "unknown",
            "server_up": server_up,
            "stream_count": len(_dedupe_keep_order(server_specific_streams)),
            "primary_stream": primary_stream,
            "embedded_url": embedded_url,
            "screenshot_url": screenshot_url,
        }
        server_records.append(json.dumps(server_record, ensure_ascii=False, sort_keys=True))

        if server.get("embedded_url"):
            embedded_url = str(server["embedded_url"])
            navigation_targets.append(f"embedded_url={embedded_url}")
            critical_links.append(embedded_url)
            url_patterns.append(_generalize_url_pattern(embedded_url))

    stream_hosts = _dedupe_keep_order([_normalize_domain(item) for item in stream_urls if item])
    server_labels = _dedupe_keep_order(
        [str(server.get("label", "")).strip() for server in servers if isinstance(server, dict)]
    )
    hosting_pages = payload.get("hosting_pages", []) if isinstance(payload, dict) else []
    for page in hosting_pages:
        page_url = ""
        if isinstance(page, dict) and page.get("url"):
            page_url = str(page["url"])
        elif isinstance(page, str):
            page_url = str(page)

        if page_url:
            hosting_candidate_urls.append(page_url)
            landing_match_urls.append(page_url)

        if isinstance(page, dict) and page.get("url"):
            navigation_targets.append(f"hosting_url={page_url}")
            critical_links.append(page_url)
            url_patterns.append(_generalize_url_pattern(page_url))
            if _looks_like_pagination_url(page_url):
                pagination_patterns.append(_generalize_url_pattern(page_url))
        if isinstance(page, dict):
            for field in ("title", "participants", "channel"):
                if page.get(field):
                    selectors.append(f"{field}={page[field]}")
            patterns = page.get("patterns", {})
            if isinstance(patterns, dict):
                for key in ("url_pattern",):
                    if patterns.get(key):
                        url_patterns.append(str(patterns[key]))
                if patterns.get("pagination") and isinstance(patterns.get("pagination"), dict):
                    pagination_url_pattern = patterns["pagination"].get("url_pattern")
                    if pagination_url_pattern:
                        pagination_patterns.append(str(pagination_url_pattern))
                    for key, value in patterns["pagination"].items():
                        if value:
                            pagination_rules.append(f"{key}={value}")

    site_patterns = payload.get("site_patterns", {}) if isinstance(payload, dict) else {}
    if isinstance(site_patterns, dict):
        pagination = site_patterns.get("pagination", {})
        if isinstance(pagination, dict):
            for key, value in pagination.items():
                if value:
                    pagination_rules.append(f"{key}={value}")

    extraction_summary = payload.get("extraction_summary", {}) if isinstance(payload, dict) else {}
    if isinstance(extraction_summary, dict):
        for key in ("pagination_detected", "pages_paginated", "pagination_rule", "stop_reason"):
            if extraction_summary.get(key):
                pagination_rules.append(f"{key}={extraction_summary.get(key)}")
        rejected_patterns.extend(_coerce_string_list(extraction_summary.get("rejected_patterns", [])))
        failure_cues.extend(_coerce_string_list(extraction_summary.get("failure_cues", [])))

    for key in ("rejected_patterns", "rejected_urls", "rejected_candidates", "blocked_patterns"):
        rejected_patterns.extend(_coerce_string_list(payload.get(key, [])) if isinstance(payload, dict) else [])

    agent_run = payload.get("agent_run", {}) if isinstance(payload, dict) else {}
    if isinstance(agent_run, dict):
        if agent_run.get("stop_reason"):
            failure_cues.append(f"stop_reason={agent_run.get('stop_reason')}")
        if agent_run.get("parse_error"):
            failure_cues.append(f"parse_error={agent_run.get('parse_error')}")
        for capsule in agent_run.get("continuation_capsules", []) or []:
            if not isinstance(capsule, dict):
                continue
            continuation_notes.append(
                json.dumps(
                    {
                        "index": capsule.get("continuation_index"),
                        "reason": capsule.get("compaction_reason"),
                        "next_best_move": capsule.get("next_best_move"),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )

    payload_urls = _extract_urls_from_payload(payload)
    critical_links.extend(payload_urls)
    url_patterns.extend([_generalize_url_pattern(candidate) for candidate in payload_urls])
    pagination_patterns.extend(
        [_generalize_url_pattern(candidate) for candidate in payload_urls if _looks_like_pagination_url(candidate)]
    )

    critical_links.extend(hosting_candidate_urls)
    critical_links.extend(server_stream_urls)
    url_patterns.extend([_generalize_url_pattern(candidate) for candidate in hosting_candidate_urls])
    pagination_patterns.extend(
        [_generalize_url_pattern(candidate) for candidate in hosting_candidate_urls if _looks_like_pagination_url(candidate)]
    )
    stream_hosts.extend([_normalize_domain(candidate) for candidate in server_stream_urls if candidate])

    run_memory = payload.get("run_memory", {}) if isinstance(payload, dict) else {}
    if isinstance(run_memory, dict):
        common_memory = run_memory.get("common", run_memory)
        if isinstance(common_memory, dict):
            selectors.extend(_coerce_string_list(common_memory.get("selectors", [])))
            critical_links.extend(_coerce_string_list(common_memory.get("critical_links", [])))
            url_patterns.extend(_coerce_string_list(common_memory.get("url_patterns", [])))
            pagination_patterns.extend(_coerce_string_list(common_memory.get("pagination_patterns", [])))
            server_labels.extend(_coerce_string_list(common_memory.get("server_labels", [])))
            stream_hosts.extend(_coerce_string_list(common_memory.get("stream_hosts", [])))

        hosting_candidate_urls.extend(_coerce_string_list(run_memory.get("hosting_candidate_urls", [])))
        server_records.extend(_coerce_string_list(run_memory.get("server_records", [])))
        server_screenshots.extend(_coerce_string_list(run_memory.get("server_screenshots", [])))
        server_stream_urls.extend(_coerce_string_list(run_memory.get("server_stream_urls", [])))
        activated_servers.extend(_coerce_string_list(run_memory.get("activated_servers", [])))

        agent_specific = run_memory.get("agent_specific", {})
        if isinstance(agent_specific, dict):
            for scoped in agent_specific.values():
                if not isinstance(scoped, dict):
                    continue
                hosting_candidate_urls.extend(_coerce_string_list(scoped.get("hosting_candidate_urls", [])))
                server_records.extend(_coerce_string_list(scoped.get("server_records", [])))
                server_screenshots.extend(_coerce_string_list(scoped.get("server_screenshots", [])))
                server_stream_urls.extend(_coerce_string_list(scoped.get("server_stream_urls", [])))
                activated_servers.extend(_coerce_string_list(scoped.get("activated_servers", [])))

    result_summary = _result_summary(page_type, status, payload)
    is_landing = page_type == "landing_page"
    is_stream_page = page_type in {"hosting_page", "embedded_page"}

    tool_limit = 16
    tool_step_limit = 24
    navigation_limit = 28 if is_landing else 18
    selector_limit = 28 if is_landing else 24 if is_stream_page else 12
    url_pattern_limit = 40 if is_landing else 28 if is_stream_page else 12
    pagination_limit = 20 if is_landing else 12
    critical_limit = 80 if is_landing else 50 if is_stream_page else 24
    server_label_limit = 48 if is_stream_page else 24
    stream_host_limit = 40 if is_stream_page else 16
    hosting_candidate_limit = 120 if is_landing else 32
    server_record_limit = 56 if is_stream_page else 16
    server_stream_limit = 80 if is_stream_page else 20
    server_screenshot_limit = 48 if is_stream_page else 16
    activated_limit = 48 if is_stream_page else 16
    playbook_limit = 56 if is_landing or is_stream_page else 16
    rejected_limit = 56 if is_landing else 24
    failure_limit = 32
    pagination_rule_limit = 32 if is_landing else 16
    landing_match_limit = 120 if is_landing else 32
    continuation_limit = 12

    return {
        "domain": _normalize_domain(url),
        "url": url,
        "page_type": page_type,
        "status": status,
        "success": status in {"success", "partial"},
        "tool_sequence": _dedupe_keep_order(tool_sequence)[:tool_limit],
        "tool_steps": _dedupe_keep_order(tool_steps)[:tool_step_limit],
        "navigation_targets": _dedupe_keep_order(navigation_targets)[:navigation_limit],
        "selectors": _dedupe_keep_order(selectors)[:selector_limit],
        "url_patterns": _dedupe_keep_order(url_patterns)[:url_pattern_limit],
        "pagination_patterns": _dedupe_keep_order(pagination_patterns)[:pagination_limit],
        "critical_links": _dedupe_keep_order(critical_links)[:critical_limit],
        "server_labels": _dedupe_keep_order(server_labels)[:server_label_limit],
        "stream_hosts": _dedupe_keep_order(stream_hosts)[:stream_host_limit],
        "hosting_candidate_urls": _dedupe_keep_order(hosting_candidate_urls)[:hosting_candidate_limit],
        "hosting_candidates_count": len(_dedupe_keep_order(hosting_candidate_urls)),
        "server_records": _dedupe_keep_order(server_records)[:server_record_limit],
        "server_stream_urls": _dedupe_keep_order(server_stream_urls)[:server_stream_limit],
        "server_screenshots": _dedupe_keep_order(server_screenshots)[:server_screenshot_limit],
        "activated_servers": _dedupe_keep_order(activated_servers)[:activated_limit],
        "playbook_steps": _dedupe_keep_order([*playbook_steps, *tool_steps])[:playbook_limit],
        "rejected_patterns": _dedupe_keep_order(rejected_patterns)[:rejected_limit],
        "failure_cues": _dedupe_keep_order(failure_cues)[:failure_limit],
        "pagination_rules": _dedupe_keep_order(pagination_rules)[:pagination_rule_limit],
        "landing_match_urls": _dedupe_keep_order(landing_match_urls)[:landing_match_limit],
        "continuation_notes": _dedupe_keep_order(continuation_notes)[:continuation_limit],
        "llm_notes": _dedupe_keep_order(llm_notes)[:4],
        "short_memory_summary": short_memory_summary[:700],
        "result_summary": result_summary,
    }


def _result_summary(page_type: str, status: str, payload: dict[str, Any]) -> str:
    if page_type == "classification":
        return f"classified as {payload.get('page_type', 'unknown')} with confidence {payload.get('confidence', 'unknown')}"
    if page_type == "landing_page":
        return f"landing run {status}; hosting pages found={len(payload.get('hosting_pages', []) or [])}"
    if page_type in {"hosting_page", "embedded_page"}:
        decision = payload.get("decision", "")
        stream_count = len(payload.get("streaming_urls", []) or []) + len(payload.get("all_stream_urls", []) or [])
        successful_servers = payload.get("successful_servers", 0)
        return (
            f"{page_type} run {status}; decision={decision or 'n/a'}; "
            f"streams={stream_count}; successful_servers={successful_servers}"
        )
    return f"{page_type} run {status}"
