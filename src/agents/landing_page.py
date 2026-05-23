"""Landing Page Agent."""

from __future__ import annotations

import re
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from src.agents.memory import build_memory_context, remember_agent_run
from src.agents.prompting import build_runtime_context, build_task_brief, compile_agent_prompt
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, StreamURL
from src.utils.channel_detection import best_channel_match, normalize_channel_name
from src.utils.config import Settings
from src.utils.instrumentation import (
    observability_span,
    set_span_output,
    using_observability_context,
)
from src.utils.logging import get_logger
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/landing_page_v1.md")
_AGENT_CONTRACT = """\
- find and return hosting page URLs from the landing page
- use navigation and page-inspection tools as needed, but stay within budget
- inspect screenshots and page structure for repeated watch-page patterns, and keep crawling distinct useful patterns until at least one hosting route is found or the meaningful frontier is exhausted
- respect the final JSON/output format defined in the base policy
- do not fabricate hosting links; only return verified live-page findings
- return channel metadata when it is visible on the landing page or candidate cards
- default downstream route is `stream_extractor`; landing does not route directly to the embedded agent
- preserve exact iframe src, frame URL, video src, player URL, and direct stream URLs in structured fields as hosting/provider hints
- act like a compact AI crawler: maintain a frontier of live/watch/listing patterns, verify representatives, expand siblings, and stop only when distinct useful patterns are exhausted
- prioritize main body/content candidates before header navigation, sidebars, sticky bars, or footer links
- stay anchored to the main URL's domain/site; external domains need explicit same-content hosting/player evidence before navigation or handoff
- treat channel-logo grids and channel directory cards as hosting candidate patterns when they lead to same-site watch/channel pages
- treat channel posters with Play/Watch overlays as hosting candidates and check for loaded server/source/player evidence after a reveal click
- work across any language or script; use layout, logos, href patterns, and visible controls before English keywords
- once a hosting pattern is verified, collect the best same-pattern siblings and keep checking other distinct live/watchable patterns instead of re-proving low-value alternatives
- if no verified hosting targets remain after crawling useful patterns, return an empty result and stop instead of inventing a next hop
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
    path = re.sub(r"/[A-Za-z0-9_-]{24,}(?=/|$)", "/{token}", path)
    path = re.sub(r"[0-9a-fA-F]{8,}", "{id}", path)
    path = re.sub(r"\d+", "{n}", path)

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


def _coerce_memory_match_records(run_memory: dict[str, Any]) -> list[dict[str, Any]]:
    records = run_memory.get("match_records", []) if isinstance(run_memory, dict) else []
    if not isinstance(records, list):
        return []
    parsed: list[dict[str, Any]] = []
    for raw in records:
        if isinstance(raw, dict):
            record = dict(raw)
        else:
            try:
                record = json.loads(str(raw or ""))
            except json.JSONDecodeError:
                continue
        if not isinstance(record, dict):
            continue
        url = str(record.get("url") or "").strip()
        if not url.startswith(("http://", "https://")) or _looks_like_low_value_url(url):
            continue
        parsed.append(record)
    return parsed


def _max_visible_live_count(run_memory: dict[str, Any]) -> int:
    if not isinstance(run_memory, dict):
        return 0
    values: list[Any] = [
        *list(run_memory.get("visible_live_counts", []) or []),
        *list(
            (run_memory.get("common", {}) or {}).get("visible_live_counts", [])
            if isinstance(run_memory.get("common"), dict)
            else []
        ),
    ]
    max_count = 0
    for value in values:
        text = str(value or "")
        for match in re.finditer(r"=(\d{1,4})\b|\b(\d{1,4})\b", text):
            raw_count = match.group(1) or match.group(2)
            try:
                max_count = max(max_count, int(raw_count))
            except (TypeError, ValueError):
                continue
    return max_count


def _safe_positive_int(value: Any) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def _expected_live_count_from_summary(extraction_summary: dict[str, Any]) -> tuple[int, str]:
    candidates = (
        ("expected_live_items_count", "model_or_visual_estimate"),
        ("visual_live_items_count", "screenshot_visual_count"),
        ("screenshot_live_items_count", "screenshot_visual_count"),
        ("visible_live_items_count", "screenshot_visual_count"),
        ("live_items_visible_count", "screenshot_visual_count"),
        ("live_matches_visible_count", "screenshot_visual_count"),
        ("expected_hosting_pages_count", "model_expected_count"),
    )
    for key, source in candidates:
        count = _safe_positive_int(extraction_summary.get(key))
        if count:
            return count, source
    return 0, ""


def _looks_like_low_value_url(url: str) -> bool:
    lowered = str(url or "").lower().strip()
    if not lowered:
        return True
    if lowered.startswith(("javascript:", "mailto:", "tel:")):
        return True
    if any(
        token in lowered
        for token in ("/privacy", "/terms", "/contact", "/about", "/login", "/register", "cdn-cgi")
    ):
        return True
    if re.search(r"\.(css|js|png|jpe?g|gif|svg|ico|webp|pdf)(\?|$)", lowered):
        return True
    return False


def _clean_optional_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_url_list(value: Any, *, base_url: str = "") -> list[str]:
    raw_items: list[Any]
    if isinstance(value, list):
        raw_items = value
    elif isinstance(value, dict):
        raw_items = [value]
    elif isinstance(value, str) and value.strip():
        raw_items = [value]
    else:
        return []

    urls: list[str] = []
    for item in raw_items:
        if isinstance(item, dict):
            candidate = str(
                item.get("url")
                or item.get("src")
                or item.get("href")
                or item.get("player_iframe_url")
                or item.get("embedded_url")
                or ""
            ).strip()
        else:
            candidate = str(item or "").strip()
        if not candidate:
            continue
        if not candidate.startswith(("http://", "https://")) and base_url:
            candidate = urljoin(base_url, candidate)
        if candidate.startswith(("http://", "https://")):
            urls.append(candidate)
    return _dedupe_keep_order(urls)


def _looks_like_stream_url(url: str) -> bool:
    candidate = str(url or "").strip().lower()
    if not candidate.startswith(("http://", "https://")):
        return False
    parsed = urlparse(candidate)
    path = parsed.path or ""
    query = parsed.query or ""
    if re.search(r"\.(m3u8|mpd|mp4|m4s|ts)(?:$|[?#])", candidate) or path.endswith(
        (".m3u8", ".mpd", ".mp4", ".m4s", ".ts")
    ):
        return True
    stream_context = bool(
        re.search(
            r"(^|[/_.-])(hls|dash|manifest|playlist|master|chunklist|m3u8|mpd|mono)([/_.-]|$)",
            path,
        )
        or re.search(r"(^|[?&])(hls|dash|m3u8|mpd|playlist|manifest|stream)=", query)
        or re.search(r"(^|[?&])(format|type|protocol)=(hls|dash|m3u8|mpd)", query)
    )
    if not stream_context:
        return False
    return bool(
        re.search(r"/(?:hls|dash|m3u8|mpd|manifest|playlist|tracks[^/]*)/", path)
        or re.search(r"(?:^|/)(?:master|index|chunklist|playlist|manifest)(?:[.-]|$)", path)
        or re.search(r"(^|[?&])(format|type|protocol)=(hls|dash|m3u8|mpd)", query)
        or (re.search(r"(?:^|/)mono(?:[.-]|$)", path) and ("token=" in query or "expires=" in query))
    )


def _extract_player_handoff_urls(
    page_dict: dict[str, Any], *, base_url: str
) -> tuple[list[str], list[str], list[str], list[str]]:
    metadata = page_dict.get("metadata") if isinstance(page_dict.get("metadata"), dict) else {}
    iframes = _normalize_url_list(
        [
            *_normalize_url_list(page_dict.get("iframes"), base_url=base_url),
            *_normalize_url_list(page_dict.get("iframe_urls"), base_url=base_url),
            *_normalize_url_list(page_dict.get("player_iframe_urls"), base_url=base_url),
            *_normalize_url_list(metadata.get("iframes"), base_url=base_url),
            *_normalize_url_list(metadata.get("iframe_urls"), base_url=base_url),
        ],
        base_url=base_url,
    )
    video_srcs = _normalize_url_list(
        [
            *_normalize_url_list(page_dict.get("video_srcs"), base_url=base_url),
            *_normalize_url_list(page_dict.get("video_sources"), base_url=base_url),
            *_normalize_url_list(page_dict.get("videos"), base_url=base_url),
            *_normalize_url_list(metadata.get("video_srcs"), base_url=base_url),
            *_normalize_url_list(metadata.get("video_sources"), base_url=base_url),
        ],
        base_url=base_url,
    )
    player_urls = _normalize_url_list(
        [
            *_normalize_url_list(page_dict.get("player_urls"), base_url=base_url),
            *_normalize_url_list(page_dict.get("embedded_urls"), base_url=base_url),
            *_normalize_url_list(page_dict.get("embed_urls"), base_url=base_url),
            *_normalize_url_list(metadata.get("player_urls"), base_url=base_url),
            *_normalize_url_list(metadata.get("embedded_urls"), base_url=base_url),
        ],
        base_url=base_url,
    )

    for raw in [page_dict.get("player_handoff_candidates"), metadata.get("player_handoff_candidates")]:
        if not isinstance(raw, list):
            continue
        for item in raw:
            if not isinstance(item, dict):
                continue
            candidate = _normalize_url_list(item, base_url=base_url)
            if not candidate:
                continue
            kind = str(item.get("type") or item.get("kind") or "").strip().lower()
            if "video" in kind:
                video_srcs.extend(candidate)
            elif "iframe" in kind:
                iframes.extend(candidate)
            else:
                player_urls.extend(candidate)

    iframes = _dedupe_keep_order(iframes)
    video_srcs = _dedupe_keep_order(video_srcs)
    player_urls = _dedupe_keep_order(player_urls)
    direct_stream_urls = _dedupe_keep_order(
        [url for url in [*iframes, *video_srcs, *player_urls] if _looks_like_stream_url(url)]
    )
    return iframes, video_srcs, player_urls, direct_stream_urls


def _has_verified_player_or_iframe(page: dict[str, Any]) -> bool:
    if isinstance(page.get("iframes"), list) and page.get("iframes"):
        return True
    if isinstance(page.get("video_srcs"), list) and page.get("video_srcs"):
        return True
    if isinstance(page.get("player_urls"), list) and page.get("player_urls"):
        return True
    route = str(page.get("route") or "").strip().lower()
    if route == "embed_agent":
        return True
    reason = " ".join(
        str(page.get(key) or "")
        for key in ("classification_reason", "route_source", "title", "participants")
    ).lower()
    if any(token in reason for token in ("replay", "vod", "archive", "finished", "full time", "full-time")):
        return False
    return bool(re.search(r"\b(live|watch|player|play|iframe|stream)\b", reason))


def _is_explicit_non_live_candidate(page: dict[str, Any]) -> bool:
    status = str(page.get("status") or "").strip().lower()
    if not status:
        return False
    if status in {"live", "on_air", "on-air", "now", "in_progress", "streaming"}:
        return False
    if status in {"upcoming", "scheduled", "not_live", "off_air", "off-air"}:
        return False
    if status in {"replay", "vod", "ended", "finished", "final", "full_time", "full-time"}:
        return not _has_verified_player_or_iframe(page)
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
            candidate_url = urljoin(source_url, candidate_url)
            page_dict["url"] = candidate_url
        if not candidate_url.startswith(("http://", "https://")):
            continue
        if candidate_url in seen_urls:
            continue
        seen_urls.add(candidate_url)

        for text_key in (
            "title",
            "participants",
            "team1",
            "team2",
            "score",
            "channel",
            "sport",
            "league",
            "type",
            "status",
            "scheduled_time",
            "route",
            "entry_point",
            "route_source",
            "screenshot_url",
        ):
            if text_key in page_dict:
                page_dict[text_key] = _clean_optional_text(page_dict.get(text_key))
        page_dict.setdefault("title", "")
        page_dict.setdefault("participants", "")
        page_dict.setdefault("team1", "")
        page_dict.setdefault("team2", "")
        page_dict.setdefault("score", "")
        page_dict.setdefault("channel", "")
        if not isinstance(page_dict.get("channel_candidates"), list):
            page_dict["channel_candidates"] = []
        page_dict["channel_candidates"] = [
            _clean_optional_text(item) for item in page_dict["channel_candidates"]
        ]
        page_dict.setdefault("sport", "")
        page_dict.setdefault("league", "")
        page_dict.setdefault("type", "")
        if not page_dict["league"] and page_dict["type"]:
            page_dict["league"] = page_dict["type"]
        if not page_dict["type"] and page_dict["league"]:
            page_dict["type"] = page_dict["league"]
        if not page_dict["participants"] and page_dict["team1"] and page_dict["team2"]:
            page_dict["participants"] = f"{page_dict['team1']} vs {page_dict['team2']}"
        page_dict.setdefault("status", "unknown")
        page_dict.setdefault("scheduled_time", "")
        page_dict.setdefault("screenshot_url", "")
        if not isinstance(page_dict.get("visual_evidence"), list):
            page_dict["visual_evidence"] = []
        page_dict["visual_evidence"] = [
            _clean_optional_text(item) for item in page_dict["visual_evidence"] if item
        ]
        page_dict.setdefault("confidence", 85)
        page_dict.setdefault("route", "stream_extractor")
        if str(page_dict.get("route") or "").strip().lower() == "embed_agent":
            page_dict["route"] = "stream_extractor"
        page_dict.setdefault("entry_point", source_url)
        if not isinstance(page_dict.get("redirect_chain"), list):
            page_dict["redirect_chain"] = []
        page_dict["redirect_chain"] = [
            _clean_optional_text(item) for item in page_dict["redirect_chain"] if item
        ]
        if not isinstance(page_dict.get("iframes"), list):
            page_dict["iframes"] = []
        iframes, video_srcs, player_urls, direct_stream_urls = _extract_player_handoff_urls(
            page_dict,
            base_url=candidate_url or source_url,
        )
        page_dict["iframes"] = iframes
        page_dict["video_srcs"] = video_srcs
        page_dict["player_urls"] = player_urls
        page_dict["direct_stream_urls"] = direct_stream_urls

        if _is_explicit_non_live_candidate(page_dict):
            continue

        raw_patterns = page_dict.get("patterns")
        patterns: dict[str, Any] = dict(raw_patterns) if isinstance(raw_patterns, dict) else {}
        if not patterns.get("url_pattern"):
            patterns["url_pattern"] = _generalize_url_pattern(candidate_url)
        page_dict["patterns"] = patterns

        channel_match = best_channel_match(
            page_dict.get("channel"),
            page_dict.get("title"),
            page_dict.get("participants"),
            candidate_url,
        )
        normalized_channel = normalize_channel_name(str(page_dict.get("channel") or "").strip())
        if not normalized_channel:
            normalized_channel = normalize_channel_name(
                str(channel_match.get("channel_name") or "").strip()
            )
        page_dict["channel"] = normalized_channel
        page_dict["channel_candidates"] = list(
            dict.fromkeys(
                [
                    normalized_channel,
                    *[
                        normalize_channel_name(item)
                        for item in channel_match.get("channel_candidates", [])
                    ],
                ]
            )
        )
        page_dict["metadata"] = {
            **(page_dict.get("metadata") if isinstance(page_dict.get("metadata"), dict) else {}),
            "channel_confidence": channel_match.get("channel_confidence", ""),
            "channel_detection_method": channel_match.get("channel_detection_method", ""),
            "channel_evidence": channel_match.get("channel_evidence", []),
            "player_handoff_urls": _dedupe_keep_order([*iframes, *video_srcs, *player_urls]),
            "direct_stream_urls": direct_stream_urls,
        }
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

    recovered_from_short_memory = 0
    for record in _coerce_memory_match_records(run_memory):
        candidate_url = str(record.get("url") or "").strip()
        if candidate_url in existing_urls:
            continue
        page_dict: dict[str, Any] = {
            "url": candidate_url,
            "title": str(record.get("title") or ""),
            "participants": str(record.get("participants") or ""),
            "channel": "",
            "channel_candidates": [],
            "sport": "",
            "league": "",
            "status": str(record.get("status") or "unknown"),
            "scheduled_time": str(record.get("scheduled_time") or ""),
            "confidence": 62,
            "classification_reason": (
                "recovered from inspect_landing candidate memory; hosting agent must verify "
                "with screenshot/player evidence"
            ),
            "servers": [],
            "iframes": [],
            "video_srcs": [],
            "player_urls": [],
            "direct_stream_urls": [],
            "screenshot_url": str(record.get("screenshot_url") or ""),
            "visual_evidence": [
                item
                for item in [
                    str(record.get("visual_evidence") or "").strip(),
                    str(record.get("screenshot_cues") or "").strip(),
                ]
                if item
            ],
            "entry_point": source_url,
            "route_source": "inspect_landing_short_memory",
            "redirect_chain": [source_url, candidate_url],
            "route": "stream_extractor",
            "patterns": {"url_pattern": str(record.get("url_pattern") or "") or _generalize_url_pattern(candidate_url)},
            "metadata": {
                "source": str(record.get("source") or ""),
                "source_section": str(record.get("source_section") or ""),
                "selector": str(record.get("selector") or ""),
                "xpath": str(record.get("xpath") or ""),
                "recovered_from": "short_memory_candidate_ledger",
            },
        }
        if _is_explicit_non_live_candidate(page_dict):
            continue
        hosting_pages.append(page_dict)
        existing_urls.add(candidate_url)
        recovered_from_short_memory += 1

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
            *list(
                run_memory.get("hosting_candidate_urls", []) if isinstance(run_memory, dict) else []
            ),
            *list(
                common_memory.get("critical_links", []) if isinstance(common_memory, dict) else []
            ),
        ]
    )

    source_domain = _normalize_domain(source_url)
    allowed_domains = {source_domain} if source_domain else set()
    for page in hosting_pages:
        page_domain = _normalize_domain(str(page.get("url") or ""))
        if page_domain:
            allowed_domains.add(page_domain)
    for record in _coerce_memory_match_records(run_memory):
        record_domain = _normalize_domain(str(record.get("url") or ""))
        if record_domain:
            allowed_domains.add(record_domain)
    expanded_count = 0
    for candidate_url in candidate_pool:
        if candidate_url in existing_urls:
            continue
        if not candidate_url.startswith(("http://", "https://")):
            continue
        candidate_domain = _normalize_domain(candidate_url)
        if allowed_domains and candidate_domain not in allowed_domains:
            continue
        if _looks_like_low_value_url(candidate_url):
            continue

        candidate_pattern = _generalize_url_pattern(candidate_url)
        candidate_signature = _normalize_pattern_signature(candidate_pattern)
        candidate_prefix = _hosting_prefix(candidate_url)
        pattern_match = bool(candidate_pattern and candidate_pattern in known_patterns)
        signature_match = bool(
            candidate_signature and candidate_signature in known_pattern_signatures
        )
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
                "video_srcs": [],
                "player_urls": [],
                "direct_stream_urls": [],
                "screenshot_url": "",
                "visual_evidence": ["same-pattern sibling expanded from verified landing representative"],
                "entry_point": source_url,
                "route": "stream_extractor",
                "patterns": {
                    "url_pattern": candidate_pattern,
                },
            }
        )

    output["hosting_pages"] = hosting_pages
    direct_stream_urls = _dedupe_keep_order(
        [
            *[
                stream_url
                for page in hosting_pages
                for stream_url in _normalize_url_list(page.get("direct_stream_urls"), base_url=source_url)
            ],
            *_normalize_url_list(output.get("direct_stream_urls"), base_url=source_url),
            *_normalize_url_list(output.get("streaming_urls"), base_url=source_url),
            *[
                item
                for item in (
                    run_memory.get("stream_urls", []) if isinstance(run_memory, dict) else []
                )
                if _looks_like_stream_url(str(item or ""))
            ],
        ]
    )
    if direct_stream_urls:
        output["direct_stream_urls"] = direct_stream_urls

    extraction_summary = output.get("extraction_summary", {})
    if isinstance(extraction_summary, dict):
        extraction_summary["hosting_pages_found"] = len(hosting_pages)
        summary_expected_count, summary_expected_source = _expected_live_count_from_summary(
            extraction_summary
        )
        memory_expected_count = _max_visible_live_count(run_memory)
        expected_live_count = max(summary_expected_count, memory_expected_count)
        if expected_live_count:
            extraction_summary["expected_live_items_count"] = expected_live_count
            extraction_summary["visible_live_count_source"] = (
                "tool_memory"
                if memory_expected_count >= summary_expected_count and memory_expected_count
                else summary_expected_source
            )
            missing_live_count = max(expected_live_count - len(hosting_pages), 0)
            extraction_summary["hosting_pages_missing_from_visible_count"] = missing_live_count
            extraction_summary["completion_gap"] = missing_live_count > 0
            if missing_live_count > 0:
                extraction_summary.setdefault(
                    "continuation_needed_reason",
                    (
                        f"visible live counter expected {expected_live_count} items but "
                        f"only {len(hosting_pages)} hosting pages were returned"
                    ),
                )
        pagination_patterns = list(
            common_memory.get("pagination_patterns", []) if isinstance(common_memory, dict) else []
        )
        if pagination_patterns:
            extraction_summary["pagination_detected"] = True
            extraction_summary.setdefault("pagination_patterns", pagination_patterns[:8])
            extraction_summary.setdefault("pages_paginated", len(pagination_patterns))
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
    if not isinstance(site_patterns.get("pagination"), dict):
        pagination_patterns = list(
            common_memory.get("pagination_patterns", []) if isinstance(common_memory, dict) else []
        )
        if pagination_patterns:
            site_patterns["pagination"] = {
                "type": "url_pattern",
                "url_pattern": pagination_patterns[0],
                "patterns_found": pagination_patterns[:8],
            }
    output["site_patterns"] = site_patterns
    output["landing_match_urls"] = _dedupe_keep_order(
        [str(page.get("url") or "").strip() for page in hosting_pages if isinstance(page, dict)]
    )

    output["pattern_expansion"] = {
        "expanded_candidates": expanded_count,
        "short_memory_recovered_candidates": recovered_from_short_memory,
        "known_patterns": len([pattern for pattern in known_patterns if pattern]),
        "known_pattern_signatures": len(
            [signature for signature in known_pattern_signatures if signature]
        ),
        "candidate_pool_size": len(candidate_pool),
    }
    return output, expanded_count


def _protocol_from_url(url: str) -> str:
    lowered = str(url or "").lower()
    if ".m3u8" in lowered or "hls" in lowered:
        return "hls"
    if ".mpd" in lowered or "dash" in lowered:
        return "dash"
    if ".mp4" in lowered:
        return "mp4"
    if ".m4s" in lowered or ".ts" in lowered:
        return "segment"
    return ""


def _collect_landing_streams(output: dict[str, Any]) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for url in _normalize_url_list(output.get("direct_stream_urls")):
        if not _looks_like_stream_url(url) or url in seen:
            continue
        seen.add(url)
        streams.append(
            StreamURL(
                url=url,
                protocol=_protocol_from_url(url),
                source_layer="landing_player_handoff",
            )
        )
    return streams


class LandingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = None
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
        from src.agents.base import build_llm, run_agent_loop
        from src.tools.mcp_client import agent_tools

        if self.llm is None:
            self.llm = build_llm(self.settings, agent_id="landing")
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
                            "orchestrator_handoff": orchestrator_handoff[:600]
                            if orchestrator_handoff
                            else "",
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
                initial_message = (
                    f"Explore this landing page and find all hosting page URLs.\n\nmainUrl: {url}"
                )
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
                        runtime_profile=AgentType.LANDING_PAGE.value,
                    )

                output_json = result.parse_json()
                run_memory = short_memory.export_run_memory(page_type=AgentType.LANDING_PAGE.value)
                output_json, expanded_candidates = _augment_landing_output(
                    output_json,
                    source_url=url,
                    run_memory=run_memory,
                )
                output_json.setdefault(
                    "agent_run",
                    {
                        "stop_reason": getattr(result, "stop_reason", "completed"),
                        "budget_exhausted": bool(getattr(result, "budget_exhausted", False)),
                        "tool_calls_used": result.tool_calls_made,
                        "bootstrap_tool_calls": int(
                            getattr(result, "bootstrap_tool_calls", 0) or 0
                        ),
                        "llm_tool_calls_made": int(
                            getattr(result, "llm_tool_calls_made", result.tool_calls_made) or 0
                        ),
                        "parse_error": str(getattr(result, "parse_error", "") or ""),
                        "continuation_count": int(
                            getattr(result, "continuation_count", 0) or 0
                        ),
                        "continuation_capsules": list(
                            getattr(result, "continuation_capsules", []) or []
                        ),
                    },
                )
                if getattr(result, "parse_error", ""):
                    output_json["raw_final_text"] = str(getattr(result, "final_text", "") or "")[
                        :4000
                    ]
                hosting_pages = output_json.get("hosting_pages", [])
                streams = _collect_landing_streams(output_json)
                extraction = ExtractionResult(
                    url=url,
                    page_type=PageType.LANDING,
                    status=ExtractionStatus.SUCCESS
                    if hosting_pages or streams
                    else ExtractionStatus.FAILED,
                    streams=streams,
                    agent_type=AgentType.LANDING_PAGE,
                    tool_calls_used=result.tool_calls_made,
                    metadata=output_json,
                )
                set_span_output(
                    span,
                    {
                        "hosting_pages_found": len(hosting_pages),
                        "direct_streams_found": len(streams),
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
                status="success" if hosting_pages or extraction.streams else "warning",
                details={
                    "hosting_pages_found": len(hosting_pages),
                    "hosting_page_urls": [
                        str(page.get("url") or "").strip()
                        for page in hosting_pages
                        if isinstance(page, dict) and str(page.get("url") or "").strip()
                    ],
                    "hosting_pages": hosting_pages[:20],
                    "direct_streams_found": len(extraction.streams),
                    "pattern_expansion": extraction.metadata.get("pattern_expansion", {}),
                },
            )
        return extraction
