"""Short-term working memory for a single website extraction run."""

from __future__ import annotations

import json
import re
from collections import deque
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse


def _normalize_domain(url: str) -> str:
    host = (urlparse(url).netloc or "").lower().strip()
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
        normalized = str(value)
        if re.fullmatch(r"\d+", normalized or ""):
            normalized = "{n}"
        elif re.fullmatch(r"[0-9a-fA-F]{8,}", normalized or ""):
            normalized = "{id}"
        elif len(normalized) >= 24 and re.fullmatch(r"[A-Za-z0-9_-]+", normalized):
            normalized = "{token}"
        query_pairs.append((key, normalized))

    query = urlencode(sorted(query_pairs), doseq=True)
    query = query.replace("%7B", "{").replace("%7D", "}")
    return urlunparse((parsed.scheme, _normalize_domain(raw), path, "", query, ""))


def _looks_like_pagination_url(url: str) -> bool:
    candidate = str(url or "").lower()
    return bool(
        candidate
        and re.search(
            r"([?&](page|p|offset|start|cursor)=)|(/page/\d+)|(/p/\d+)|(-page-\d+)", candidate
        )
    )


def _looks_like_article_or_news_url(url: str) -> bool:
    path = urlparse(str(url or "").strip()).path.lower()
    return bool(
        path
        and re.search(
            r"/(?:read|post|posts|article|articles|news|blog|story|stories)(?:/|$)",
            path,
        )
    )


def _has_strong_match_card_evidence(entry: dict[str, Any]) -> bool:
    if str(entry.get("source") or "").strip().lower() == "nav":
        return False
    structural_haystack = " ".join(
        str(entry.get(key) or "")
        for key in (
            "nearby_text",
            "row_text",
            "scheduled_time",
            "source_section",
            "route_source",
            "selector",
            "xpath",
            "classes",
        )
    )
    title_haystack = " ".join(
        str(entry.get(key) or "") for key in ("title", "text", "participants")
    )
    if re.search(
        r"\b(player|iframe|server|source|embed|video|match card|fixture|schedule row|live row|watch button|play button)\b",
        f"{structural_haystack} {title_haystack}",
        re.IGNORECASE,
    ):
        return True
    if re.search(
        r"\b(news|article|blog|related|recommended|popular)\b",
        structural_haystack,
        re.IGNORECASE,
    ):
        return False
    return bool(
        re.search(
            r"(\bvs\.?\b|\bv\b|versus|@| x |\d{1,2}:\d{2}|score|kickoff|against)",
            structural_haystack,
            re.IGNORECASE,
        )
        or (
            re.search(
                r"(\bvs\.?\b|\bv\b|versus|@| x |\d{1,2}:\d{2}|score|kickoff|against)",
                title_haystack,
                re.IGNORECASE,
            )
            and re.search(
                r"\b(match|fixture|event|schedule|live|card|row|team|club|channel|player|server)\b",
                structural_haystack,
                re.IGNORECASE,
            )
        )
    )


def _looks_like_article_only_candidate(url: str, entry: dict[str, Any] | None = None) -> bool:
    if not _looks_like_article_or_news_url(url):
        return False
    return not _has_strong_match_card_evidence(entry or {})


def _looks_like_stream_url(url: str) -> bool:
    candidate = str(url or "").strip().lower()
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


def _dedupe_keep_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _extract_nested_strings(payload: Any, keys: set[str], *, limit: int = 150) -> list[str]:
    found: list[str] = []

    def _walk(node: Any) -> None:
        if len(found) >= limit:
            return
        if isinstance(node, dict):
            for key, value in node.items():
                if len(found) >= limit:
                    break
                lowered = str(key or "").lower()
                if lowered in keys and isinstance(value, str):
                    found.append(value)
                elif lowered.endswith("_url") and isinstance(value, str):
                    found.append(value)
                elif (lowered in keys or lowered.endswith("_urls")) and isinstance(value, list):
                    for item in value:
                        if isinstance(item, str):
                            found.append(item)
                            if len(found) >= limit:
                                break
                        elif isinstance(item, (dict, list, tuple)):
                            _walk(item)
                elif isinstance(value, (dict, list, tuple)):
                    _walk(value)
        elif isinstance(node, (list, tuple)):
            for item in node:
                if len(found) >= limit:
                    break
                _walk(item)

    _walk(payload)
    return _dedupe_keep_order(found)


def _extract_live_count_signals(payload: Any, *, limit: int = 20) -> list[str]:
    signals: list[str] = []
    count_patterns = (
        re.compile(
            r"\b(live\s+(?:matches|streams?|events?|channels?|games?))\s*[:#-]?\s*\(?\s*(\d{1,4})\s*\)?",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(\d{1,4})\s+(live\s+(?:matches|streams?|events?|channels?|games?))\b",
            re.IGNORECASE,
        ),
    )

    def _add(label: str, count: str) -> None:
        try:
            parsed = int(count)
        except (TypeError, ValueError):
            return
        if parsed <= 0:
            return
        normalized_label = re.sub(r"\s+", "_", str(label or "live_items").strip().lower())
        signals.append(f"{normalized_label}={parsed}")

    def _walk(node: Any) -> None:
        if len(signals) >= limit:
            return
        if isinstance(node, dict):
            for key, value in node.items():
                if len(signals) >= limit:
                    break
                key_text = str(key or "").strip().lower()
                if isinstance(value, int) and value > 0 and re.search(
                    r"(live|on_air|online).*(count|total)|count.*(live|on_air|online)",
                    key_text,
                ):
                    _add(key_text, str(value))
                elif isinstance(value, str):
                    _walk(value)
                elif isinstance(value, (dict, list, tuple)):
                    _walk(value)
        elif isinstance(node, (list, tuple)):
            for item in node:
                if len(signals) >= limit:
                    break
                _walk(item)
        elif isinstance(node, str):
            for pattern in count_patterns:
                for match in pattern.finditer(node):
                    first, second = match.group(1), match.group(2)
                    if first.isdigit():
                        _add(second, first)
                    else:
                        _add(first, second)

    _walk(payload)
    return _dedupe_keep_order(signals)[:limit]


def _resolve_url_candidate(candidate: str, *, base_url: str) -> str:
    raw = str(candidate or "").strip()
    if not raw:
        return ""
    if raw.startswith(("http://", "https://")):
        return raw
    if raw.startswith(("//", "/", "./", "../")) and base_url.startswith(("http://", "https://")):
        resolved = urljoin(base_url, raw)
        if resolved.startswith(("http://", "https://")):
            return resolved
    return ""


class ShortTermMemory:
    """Keeps the current run's working state compact and extraction-focused.

    This is intentionally not a generic chat memory. It tracks the things that
    matter for site extraction work: visited URLs, tool attempts, selectors,
    and short observations that can be summarized or persisted later.
    """

    def __init__(self, k: int = 40, page_type: str = "") -> None:
        self.k = max(int(k or 1), 1)
        self.page_type = str(page_type or "").strip().lower()
        self._entries: deque[dict[str, Any]] = deque(maxlen=self.k)
        self._signals: dict[str, list[str]] = {
            "url_patterns": [],
            "pagination_patterns": [],
            "selectors": [],
            "critical_links": [],
            "iframe_urls": [],
            "stream_urls": [],
            "stream_hosts": [],
            "server_labels": [],
            "hosting_candidate_urls": [],
            "match_records": [],
            "visible_live_counts": [],
            "server_records": [],
            "server_frontier": [],
            "activation_targets": [],
            "blocker_targets": [],
            "observed_changes": [],
            "server_screenshots": [],
            "server_stream_urls": [],
            "activated_servers": [],
        }

    def save(self, human: str, ai: str) -> None:
        """Backward-compatible helper for old call sites."""
        self.record_observation(f"Human: {human}")
        self.record_observation(f"AI: {ai}")

    def load(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def clear(self) -> None:
        self._entries.clear()
        for key in self._signals:
            self._signals[key] = []

    def record_navigation(self, url: str, *, via: str = "", note: str = "") -> None:
        if not (url or via or note):
            return
        self._entries.append(
            {
                "kind": "navigation",
                "url": url,
                "via": via,
                "note": note,
            }
        )

    def record_tool(
        self,
        tool_name: str,
        tool_args: dict[str, Any] | None = None,
        *,
        status: str = "info",
        result_preview: str = "",
    ) -> None:
        self._entries.append(
            {
                "kind": "tool",
                "tool_name": tool_name,
                "tool_args": tool_args or {},
                "status": status,
                "result_preview": result_preview[:400],
            }
        )

    def ingest_tool_result(
        self,
        tool_name: str,
        tool_args: dict[str, Any] | None,
        result_payload: str | dict[str, Any] | None,
    ) -> None:
        args = tool_args or {}
        for key in ("url", "mainUrl", "base_url", "player_iframe_url", "embedded_url"):
            value = args.get(key)
            if value:
                self._capture_url(str(value))

        base_url = ""
        for key in ("url", "mainUrl", "base_url"):
            value = str(args.get(key) or "").strip()
            if value.startswith(("http://", "https://")):
                base_url = value
                break

        for key in ("selector", "xpath", "text", "element_ref", "kind", "action"):
            value = args.get(key)
            if value:
                self._remember_signal("selectors", f"{key}={value}", max_items=40)

        payload: Any = result_payload
        if isinstance(result_payload, str):
            text = result_payload.strip()
            if not text:
                payload = {}
            else:
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    payload = {}

        if not isinstance(payload, (dict, list, tuple)):
            return

        if isinstance(payload, dict) and not base_url:
            payload_url = str(payload.get("url") or payload.get("final_url") or "").strip()
            if payload_url.startswith(("http://", "https://")):
                base_url = payload_url

        urls = _extract_nested_strings(
            payload,
            {
                "url",
                "href",
                "src",
                "final_url",
                "embedded_url",
                "player_iframe_url",
                "source_url",
            },
        )
        for candidate in urls:
            resolved = _resolve_url_candidate(candidate, base_url=base_url)
            if resolved:
                self._capture_url(resolved)

        for selector in _extract_nested_strings(
            payload, {"selector", "xpath", "element_ref", "text"}
        ):
            self._remember_signal("selectors", selector, max_items=40)

        for label in _extract_nested_strings(payload, {"label", "server_label", "server"}):
            cleaned = str(label or "").strip()
            if cleaned and len(cleaned) <= 120:
                self._remember_signal("server_labels", cleaned, max_items=120)

        if isinstance(payload, dict):
            for signal in _extract_live_count_signals(payload):
                self._remember_signal(
                    "visible_live_counts",
                    signal,
                    max_items=self._signal_limit("visible_live_counts"),
                )
            self._capture_hosting_candidates(payload, base_url=base_url)
            self._capture_server_frontier(payload, base_url=base_url)
            self._capture_server_artifacts(payload)

        if tool_name in {"memory_update", "memory_lookup"}:
            self.record_observation(
                f"memory tool used: {tool_name}",
                source="memory",
            )

    def record_observation(self, note: str, *, source: str = "") -> None:
        text = str(note or "").strip()
        if not text:
            return
        self._entries.append(
            {
                "kind": "observation",
                "source": source,
                "note": text[:500],
            }
        )

    def summary(self, limit: int = 8) -> str:
        recent = list(self._entries)[-max(int(limit or 1), 1) :]
        if not recent:
            run_memory = self.export_run_memory()
            common = run_memory.get("common", {}) if isinstance(run_memory, dict) else {}
            if not any(common.values()) and not run_memory.get("agent_specific"):
                return ""
            lines = ["- run memory: structured signals captured"]
            if common.get("url_patterns"):
                lines.append("- run url patterns: " + ", ".join(common["url_patterns"][:4]))
            if common.get("critical_links"):
                lines.append("- run critical links: " + ", ".join(common["critical_links"][:4]))
            if common.get("stream_urls"):
                lines.append("- run stream urls: " + ", ".join(common["stream_urls"][:3]))
            if run_memory.get("page_type") == "landing_page":
                candidates = run_memory.get("hosting_candidate_urls", [])
                if candidates:
                    lines.append(f"- landing candidates remembered: {len(candidates)}")
            if run_memory.get("page_type") in {"hosting_page", "embedded_page"}:
                server_records = run_memory.get("server_records", [])
                if server_records:
                    lines.append(f"- server records remembered: {len(server_records)}")
            return "\n".join(lines)

        lines: list[str] = []
        for entry in recent:
            kind = entry.get("kind")
            if kind == "navigation":
                url = entry.get("url", "")
                via = entry.get("via", "")
                note = entry.get("note", "")
                parts = [part for part in [url, via, note] if part]
                if parts:
                    lines.append("- nav: " + " | ".join(parts))
            elif kind == "tool":
                tool_name = entry.get("tool_name", "unknown")
                status = entry.get("status", "info")
                args = entry.get("tool_args", {}) or {}
                target = ""
                for key in (
                    "url",
                    "selector",
                    "text",
                    "xpath",
                    "player_iframe_url",
                    "kind",
                    "action",
                ):
                    if args.get(key):
                        target = f"{key}={args[key]}"
                        break
                line = f"- tool: {tool_name} [{status}]"
                if target:
                    line += f" on {target}"
                if entry.get("result_preview"):
                    line += f" -> {entry['result_preview'][:120]}"
                lines.append(line)
            elif kind == "observation":
                prefix = f"{entry.get('source')}: " if entry.get("source") else ""
                lines.append(f"- note: {prefix}{entry.get('note', '')}")

        run_memory = self.export_run_memory()
        common = run_memory.get("common", {}) if isinstance(run_memory, dict) else {}
        if common.get("url_patterns"):
            lines.append("- run url patterns: " + ", ".join(common["url_patterns"][:4]))
        if common.get("pagination_patterns"):
            lines.append(
                "- run pagination patterns: " + ", ".join(common["pagination_patterns"][:3])
            )
        if common.get("critical_links"):
            lines.append("- run critical links: " + ", ".join(common["critical_links"][:4]))
        if common.get("stream_urls"):
            lines.append("- run stream urls: " + ", ".join(common["stream_urls"][:3]))
        if run_memory.get("page_type") == "landing_page" and run_memory.get(
            "hosting_candidate_urls"
        ):
            lines.append(
                f"- landing candidates remembered: {len(run_memory['hosting_candidate_urls'])}"
            )
        if run_memory.get("page_type") == "landing_page" and run_memory.get(
            "visible_live_counts"
        ):
            lines.append(
                "- visible live counters: " + ", ".join(run_memory["visible_live_counts"][:3])
            )
        if run_memory.get("page_type") in {"hosting_page", "embedded_page"} and run_memory.get(
            "server_records"
        ):
            lines.append(f"- server records remembered: {len(run_memory['server_records'])}")
        if run_memory.get("page_type") in {"hosting_page", "embedded_page"} and run_memory.get(
            "server_frontier"
        ):
            lines.append(f"- server/source frontier remembered: {len(run_memory['server_frontier'])}")
        return "\n".join(lines)

    def working_state(
        self,
        *,
        objective: str,
        page_url: str = "",
        page_type: str = "",
        anchor_url: str = "",
        navigation_policy: str = "",
        limit: int = 8,
    ) -> str:
        recent = list(self._entries)[-max(int(limit or 1), 1) :]
        current_target = page_url or self._last_navigation_url(recent)
        steps = self._steps_already_tried(recent)
        blockers = self._blockers_seen(recent)
        last_success = self._last_successful_action(recent)
        next_best_move = self._next_best_move(recent, blockers)
        run_memory = self.export_run_memory()
        common = run_memory.get("common", {}) if isinstance(run_memory, dict) else {}

        lines = [
            f"- current objective: {str(objective or '').strip()}",
            f"- current page type: `{page_type or 'unknown'}`",
            f"- current target url: `{current_target or 'unknown'}`",
            "- steps already tried: "
            + (", ".join(f"`{step}`" for step in steps[:5]) if steps else "`none yet`"),
            "- blockers seen: "
            + (", ".join(f"`{blocker}`" for blocker in blockers[:3]) if blockers else "`none yet`"),
            f"- last successful action: `{last_success or 'none yet'}`",
            "- detected run url patterns: "
            + (
                ", ".join(f"`{item}`" for item in common.get("url_patterns", [])[:4])
                if common.get("url_patterns")
                else "`none yet`"
            ),
            "- detected pagination patterns: "
            + (
                ", ".join(f"`{item}`" for item in common.get("pagination_patterns", [])[:3])
                if common.get("pagination_patterns")
                else "`none yet`"
            ),
            "- critical links discovered this run: "
            + (
                ", ".join(f"`{item}`" for item in common.get("critical_links", [])[:5])
                if common.get("critical_links")
                else "`none yet`"
            ),
            "- stream links discovered this run: "
            + (
                ", ".join(f"`{item}`" for item in common.get("stream_urls", [])[:3])
                if common.get("stream_urls")
                else "`none yet`"
            ),
        ]
        if anchor_url:
            lines.append(f"- assigned anchor url: `{anchor_url}`")
        if navigation_policy:
            lines.append(f"- navigation policy: {navigation_policy}")

        if (page_type or self.page_type) == "landing_page":
            candidates = run_memory.get("hosting_candidate_urls", [])
            lines.append(
                "- landing hosting candidates remembered: "
                + (f"`{len(candidates)}`" if candidates else "`none yet`")
            )
            live_counts = run_memory.get("visible_live_counts", [])
            if live_counts:
                lines.append(
                    "- visible live counters: "
                    + ", ".join(f"`{item}`" for item in live_counts[:4])
                )
            match_records = run_memory.get("match_records", [])
            if match_records:
                lines.append(f"- landing match records remembered: `{len(match_records)}`")
        if (page_type or self.page_type) in {"hosting_page", "embedded_page"}:
            server_records = run_memory.get("server_records", [])
            lines.append(
                "- server snapshots remembered: "
                + (f"`{len(server_records)}`" if server_records else "`none yet`")
            )
            server_frontier = run_memory.get("server_frontier", [])
            lines.append(
                "- pending server/source frontier remembered: "
                + (f"`{len(server_frontier)}`" if server_frontier else "`none yet`")
            )
            activation_targets = run_memory.get("activation_targets", [])
            lines.append(
                "- activation targets remembered: "
                + (
                    ", ".join(f"`{item}`" for item in activation_targets[:4])
                    if activation_targets
                    else "`none yet`"
                )
            )
            observed_changes = run_memory.get("observed_changes", [])
            if observed_changes:
                lines.append(
                    "- recent observed changes: "
                    + ", ".join(f"`{item}`" for item in observed_changes[:4])
                )
            activated = run_memory.get("activated_servers", [])
            lines.append(
                "- activated servers in this run: "
                + (", ".join(f"`{item}`" for item in activated[:8]) if activated else "`none yet`")
            )
            iframe_urls = run_memory.get("iframe_urls", [])
            lines.append(
                "- recent iframe/embed evidence: "
                + (
                    ", ".join(f"`{item}`" for item in iframe_urls[:4])
                    if iframe_urls
                    else "`none yet`"
                )
            )

        lines.append(f"- next best move: {next_best_move}")
        return "\n".join(lines)

    def export_run_memory(self, *, page_type: str = "") -> dict[str, Any]:
        resolved_page_type = str(page_type or self.page_type or "").strip().lower()
        common = {
            "url_patterns": list(self._signals["url_patterns"]),
            "pagination_patterns": list(self._signals["pagination_patterns"]),
            "selectors": list(self._signals["selectors"]),
            "critical_links": list(self._signals["critical_links"]),
            "iframe_urls": list(self._signals["iframe_urls"]),
            "stream_urls": list(self._signals["stream_urls"]),
            "stream_hosts": list(self._signals["stream_hosts"]),
            "server_labels": list(self._signals["server_labels"]),
            "visible_live_counts": list(self._signals["visible_live_counts"]),
        }

        landing_specific = {
            "hosting_candidate_urls": list(self._signals["hosting_candidate_urls"]),
            "match_records": list(self._signals["match_records"]),
            "visible_live_counts": list(self._signals["visible_live_counts"]),
        }
        hosting_specific = {
            "server_records": list(self._signals["server_records"]),
            "server_frontier": list(self._signals["server_frontier"]),
            "activation_targets": list(self._signals["activation_targets"]),
            "blocker_targets": list(self._signals["blocker_targets"]),
            "observed_changes": list(self._signals["observed_changes"]),
            "server_screenshots": list(self._signals["server_screenshots"]),
            "server_stream_urls": list(self._signals["server_stream_urls"]),
            "activated_servers": list(self._signals["activated_servers"]),
        }

        agent_specific: dict[str, dict[str, list[str]]] = {}
        if resolved_page_type == "landing_page":
            agent_specific = {resolved_page_type: landing_specific}
        elif resolved_page_type in {"hosting_page", "embedded_page"}:
            agent_specific = {resolved_page_type: hosting_specific}
        elif resolved_page_type:
            agent_specific = {resolved_page_type: {}}

        return {
            **common,
            "hosting_candidate_urls": landing_specific["hosting_candidate_urls"],
            "match_records": landing_specific["match_records"],
            "visible_live_counts": landing_specific["visible_live_counts"],
            "iframe_urls": common["iframe_urls"],
            "server_records": hosting_specific["server_records"],
            "server_frontier": hosting_specific["server_frontier"],
            "activation_targets": hosting_specific["activation_targets"],
            "blocker_targets": hosting_specific["blocker_targets"],
            "observed_changes": hosting_specific["observed_changes"],
            "server_screenshots": hosting_specific["server_screenshots"],
            "server_stream_urls": hosting_specific["server_stream_urls"],
            "activated_servers": hosting_specific["activated_servers"],
            "page_type": resolved_page_type,
            "common": common,
            "agent_specific": agent_specific,
        }

    def _remember_signal(self, key: str, value: str, *, max_items: int) -> None:
        bucket = self._signals.get(key)
        if bucket is None:
            return
        merged = _dedupe_keep_order([*bucket, str(value or "")])
        self._signals[key] = merged[:max_items]

    def _signal_limit(self, key: str) -> int:
        page_type = self.page_type
        base_limits = {
            "url_patterns": 260,
            "pagination_patterns": 140,
            "selectors": 160,
            "critical_links": 220,
            "iframe_urls": 220,
            "stream_urls": 260,
            "stream_hosts": 120,
            "server_labels": 120,
            "hosting_candidate_urls": 260,
            "match_records": 260,
            "visible_live_counts": 60,
            "server_records": 220,
            "server_frontier": 220,
            "activation_targets": 140,
            "blocker_targets": 120,
            "observed_changes": 120,
            "server_screenshots": 220,
            "server_stream_urls": 320,
            "activated_servers": 140,
        }
        if page_type == "landing_page":
            base_limits.update(
                {
                    "critical_links": 900,
                    "url_patterns": 360,
                    "hosting_candidate_urls": 900,
                    "match_records": 900,
                    "visible_live_counts": 80,
                }
            )
        if page_type in {"hosting_page", "embedded_page"}:
            base_limits.update(
                {
                    "critical_links": 420,
                    "iframe_urls": 420,
                    "stream_urls": 700,
                    "server_labels": 220,
                    "server_records": 320,
                    "server_frontier": 420,
                    "activation_targets": 260,
                    "blocker_targets": 220,
                    "observed_changes": 220,
                    "server_screenshots": 320,
                    "server_stream_urls": 900,
                    "activated_servers": 220,
                }
            )
        return base_limits.get(key, 120)

    def _capture_url(self, url: str) -> None:
        candidate = str(url or "").strip()
        if not candidate:
            return
        self._remember_signal(
            "critical_links", candidate, max_items=self._signal_limit("critical_links")
        )

        pattern = _generalize_url_pattern(candidate)
        if pattern:
            self._remember_signal(
                "url_patterns", pattern, max_items=self._signal_limit("url_patterns")
            )
            if _looks_like_pagination_url(candidate):
                self._remember_signal(
                    "pagination_patterns",
                    pattern,
                    max_items=self._signal_limit("pagination_patterns"),
                )

        if _looks_like_stream_url(candidate):
            self._remember_signal(
                "stream_urls", candidate, max_items=self._signal_limit("stream_urls")
            )
            host = _normalize_domain(candidate)
            if host:
                self._remember_signal(
                    "stream_hosts", host, max_items=self._signal_limit("stream_hosts")
                )

    def _capture_hosting_candidates(self, payload: dict[str, Any], *, base_url: str = "") -> None:
        discovered: list[str] = []
        for key in ("hosting_pages", "match_candidates", "top_match_candidates", "candidate_ledger"):
            entries = payload.get(key, [])
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict):
                    candidate = str(entry.get("url") or entry.get("href") or "").strip()
                elif isinstance(entry, str):
                    candidate = str(entry).strip()
                else:
                    continue
                resolved = _resolve_url_candidate(candidate, base_url=base_url)
                if (
                    resolved
                    and not _looks_like_pagination_url(resolved)
                    and not _looks_like_article_only_candidate(
                        resolved,
                        entry if isinstance(entry, dict) else {},
                    )
                ):
                    discovered.append(resolved)
                    if isinstance(entry, dict):
                        patterns = entry.get("patterns") if isinstance(entry.get("patterns"), dict) else {}
                        url_pattern = str(
                            entry.get("url_pattern") or patterns.get("url_pattern") or ""
                        )
                        record = {
                            "url": resolved,
                            "title": str(
                                entry.get("title")
                                or entry.get("text")
                                or entry.get("nearby_text")
                                or ""
                            )[:180],
                            "participants": str(
                                entry.get("participants") or entry.get("nearby_text") or ""
                            )[:220],
                            "status": str(entry.get("status") or "unknown")[:40],
                            "route": str(entry.get("route") or "")[:60],
                            "scheduled_time": str(entry.get("scheduled_time") or "")[:40],
                            "source": str(entry.get("source") or "")[:60],
                            "source_section": str(entry.get("source_section") or "")[:120],
                            "selector": str(entry.get("selector") or "")[:180],
                            "xpath": str(entry.get("xpath") or "")[:220],
                            "url_pattern": url_pattern[:240],
                            "iframe_count": len(entry.get("iframes") or [])
                            if isinstance(entry.get("iframes"), list)
                            else 0,
                        }
                        self._remember_signal(
                            "match_records",
                            json.dumps(record, ensure_ascii=False, sort_keys=True),
                            max_items=self._signal_limit("match_records"),
                        )

        for candidate in _dedupe_keep_order(discovered):
            self._remember_signal(
                "hosting_candidate_urls",
                candidate,
                max_items=self._signal_limit("hosting_candidate_urls"),
            )
            self._capture_url(candidate)

    def _capture_server_frontier(self, payload: dict[str, Any], *, base_url: str = "") -> None:
        for key in ("server_frontier", "event_server_routes", "top_server_controls", "top_source_controls"):
            self._capture_frontier_entries(payload.get(key), source=key, base_url=base_url)

        for key in ("control_groups", "playback_groups", "player_groups", "frame_focus_groups"):
            groups = payload.get(key, [])
            if not isinstance(groups, list):
                continue
            for group in groups:
                if not isinstance(group, dict):
                    continue
                group_label = str(group.get("label") or group.get("group_id") or key).strip()
                for nested_key in ("sample_items", "items", "controls", "sample_controls"):
                    self._capture_frontier_entries(
                        group.get(nested_key),
                        source=f"{key}:{group_label}",
                        base_url=base_url,
                    )

        self._capture_target_entries(
            payload.get("activation_candidates"),
            key="activation_targets",
            source="activation_candidates",
            base_url=base_url,
        )
        for key in ("top_playback_targets", "top_player_targets"):
            self._capture_target_entries(
                payload.get(key),
                key="activation_targets",
                source=key,
                base_url=base_url,
            )
        self._capture_target_entries(
            payload.get("blocker_candidates"),
            key="blocker_targets",
            source="blocker_candidates",
            base_url=base_url,
        )
        self._capture_target_entries(
            payload.get("popups"),
            key="blocker_targets",
            source="popups",
            base_url=base_url,
        )

        observed_change = payload.get("observed_change")
        if isinstance(observed_change, dict):
            self._remember_observed_change(observed_change, base_url=base_url)

    def _capture_frontier_entries(self, entries: Any, *, source: str, base_url: str = "") -> None:
        if not isinstance(entries, list):
            return
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            record = self._compact_target_record(entry, source=source, index=index)
            if not record:
                continue
            self._remember_signal(
                "server_frontier",
                json.dumps(record, ensure_ascii=False, sort_keys=True),
                max_items=self._signal_limit("server_frontier"),
            )
            label = str(record.get("label") or "").strip()
            if label:
                self._remember_signal(
                    "server_labels",
                    label,
                    max_items=self._signal_limit("server_labels"),
                )
            for url_key in ("url", "href", "source_url", "embedded_url", "player_iframe_url"):
                resolved = _resolve_url_candidate(str(entry.get(url_key) or ""), base_url=base_url)
                if resolved:
                    self._capture_url(resolved)

    def _capture_target_entries(
        self,
        entries: Any,
        *,
        key: str,
        source: str,
        base_url: str = "",
    ) -> None:
        if not isinstance(entries, list):
            return
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            record = self._compact_target_record(entry, source=source, index=index)
            if not record:
                continue
            self._remember_signal(
                key,
                json.dumps(record, ensure_ascii=False, sort_keys=True),
                max_items=self._signal_limit(key),
            )
            for url_key in ("url", "href", "src", "source_url", "embedded_url", "player_iframe_url"):
                resolved = _resolve_url_candidate(str(entry.get(url_key) or ""), base_url=base_url)
                if resolved:
                    self._capture_url(resolved)

    def _compact_target_record(self, entry: dict[str, Any], *, source: str, index: int) -> dict[str, Any]:
        label = str(
            entry.get("label")
            or entry.get("text")
            or entry.get("title")
            or entry.get("kind")
            or entry.get("action")
            or entry.get("reason")
            or f"{source}_{index + 1}"
        ).strip()
        record: dict[str, Any] = {"source": source, "label": label[:140]}
        for key in (
            "source_group",
            "source_index",
            "source_url",
            "url",
            "href",
            "selector",
            "xpath",
            "element_ref",
            "frame_path",
            "route_pattern",
            "current_marker",
            "action",
            "kind",
            "reason",
        ):
            value = entry.get(key)
            if value in (None, "", [], {}):
                continue
            if isinstance(value, (dict, list)):
                record[key] = json.dumps(value, ensure_ascii=False, sort_keys=True)[:260]
            else:
                record[key] = str(value)[:260]
        return {key: value for key, value in record.items() if value not in ("", None)}

    def _remember_observed_change(self, observed_change: dict[str, Any], *, base_url: str = "") -> None:
        record: dict[str, Any] = {}
        for key in (
            "navigated",
            "url",
            "url_after",
            "active_page_url",
            "selected_target",
            "target_decision",
            "playback_started",
            "media_state",
        ):
            value = observed_change.get(key)
            if value in (None, "", [], {}):
                continue
            record[key] = str(value)[:220]
        for key in ("opened_targets", "blocked_popup_attempts", "new_tab_urls"):
            values = observed_change.get(key)
            if isinstance(values, list) and values:
                record[key] = json.dumps(values[:5], ensure_ascii=False, sort_keys=True)[:500]
        if record:
            self._remember_signal(
                "observed_changes",
                json.dumps(record, ensure_ascii=False, sort_keys=True),
                max_items=self._signal_limit("observed_changes"),
            )
        for candidate in _extract_nested_strings(
            observed_change,
            {"url", "href", "src", "url_after", "active_page_url", "selected_target"},
        ):
            resolved = _resolve_url_candidate(candidate, base_url=base_url)
            if resolved:
                self._capture_url(resolved)

    def _capture_server_artifacts(self, payload: dict[str, Any]) -> None:
        for label in (
            payload.get("all_detected_servers", [])
            if isinstance(payload.get("all_detected_servers"), list)
            else []
        ):
            cleaned = str(label or "").strip()
            if cleaned:
                self._remember_signal(
                    "server_labels", cleaned, max_items=self._signal_limit("server_labels")
                )

        servers = payload.get("servers", [])
        if not isinstance(servers, list):
            return

        for index, server in enumerate(servers):
            if not isinstance(server, dict):
                continue
            label = str(
                server.get("label")
                or server.get("name")
                or server.get("server")
                or f"server_{index + 1}"
            ).strip()
            status = str(server.get("status") or "").strip().lower()
            player_state = str(server.get("player_state") or "").strip().lower()
            server_up = bool(server.get("server_up"))
            screenshot_url = str(server.get("screenshot_url") or "").strip()
            embedded_url = str(server.get("embedded_url") or "").strip()
            embedded_url_source = str(server.get("embedded_url_source") or "").strip()
            player_iframe_url = str(server.get("player_iframe_url") or "").strip()
            primary_stream = str(server.get("primary_stream") or "").strip()

            if label:
                self._remember_signal(
                    "server_labels", label, max_items=self._signal_limit("server_labels")
                )
            if screenshot_url:
                self._remember_signal(
                    "server_screenshots",
                    screenshot_url,
                    max_items=self._signal_limit("server_screenshots"),
                )
            for iframe_candidate in (embedded_url, player_iframe_url):
                if iframe_candidate.startswith(("http://", "https://")):
                    self._remember_signal(
                        "iframe_urls",
                        iframe_candidate,
                        max_items=self._signal_limit("iframe_urls"),
                    )
                    self._capture_url(iframe_candidate)

            stream_urls: list[str] = []
            for field in ("stream_urls", "m3u8_urls", "mpd_urls", "mp4_urls"):
                values = server.get(field, [])
                if not isinstance(values, list):
                    continue
                for value in values:
                    candidate = str(value or "").strip()
                    if candidate:
                        stream_urls.append(candidate)
            if primary_stream:
                stream_urls.append(primary_stream)

            unique_streams = _dedupe_keep_order(stream_urls)
            for stream_url in unique_streams:
                if stream_url.startswith(("http://", "https://")):
                    self._remember_signal(
                        "server_stream_urls",
                        stream_url,
                        max_items=self._signal_limit("server_stream_urls"),
                    )
                    self._capture_url(stream_url)

            is_activated = (
                server_up
                or status in {"success", "partial", "active"}
                or player_state
                in {
                    "playing",
                    "loading",
                    "ready",
                }
            )
            if is_activated and label:
                self._remember_signal(
                    "activated_servers",
                    label,
                    max_items=self._signal_limit("activated_servers"),
                )

            server_record = {
                "label": label,
                "status": status or ("success" if server_up else "unknown"),
                "player_state": player_state or "unknown",
                "server_up": server_up,
                "stream_count": len(unique_streams),
                "primary_stream": primary_stream,
                "embedded_url": embedded_url,
                "embedded_url_source": embedded_url_source,
                "player_iframe_url": player_iframe_url,
                "screenshot_url": screenshot_url,
            }
            self._remember_signal(
                "server_records",
                json.dumps(server_record, ensure_ascii=False, sort_keys=True),
                max_items=self._signal_limit("server_records"),
            )

    def _last_navigation_url(self, entries: list[dict[str, Any]]) -> str:
        for entry in reversed(entries):
            if entry.get("kind") == "navigation" and entry.get("url"):
                return str(entry["url"])
        return ""

    def _steps_already_tried(self, entries: list[dict[str, Any]]) -> list[str]:
        steps: list[str] = []
        for entry in entries:
            kind = entry.get("kind")
            if kind == "navigation":
                url = str(entry.get("url", "")).strip()
                via = str(entry.get("via", "")).strip()
                if url or via:
                    steps.append("navigate " + " via ".join(part for part in [url, via] if part))
            elif kind == "tool":
                tool_name = str(entry.get("tool_name", "unknown")).strip() or "unknown"
                args = entry.get("tool_args", {}) or {}
                target = ""
                for key in ("url", "selector", "text", "xpath", "element_ref", "player_iframe_url"):
                    if args.get(key):
                        target = f"{key}={args[key]}"
                        break
                step = tool_name if not target else f"{tool_name} on {target}"
                steps.append(step)
        return steps

    def _blockers_seen(self, entries: list[dict[str, Any]]) -> list[str]:
        blockers: list[str] = []
        for entry in entries:
            texts = [
                str(entry.get("note", "")),
                str(entry.get("result_preview", "")),
            ]
            joined = " ".join(text.lower() for text in texts if text).strip()
            if not joined:
                continue
            if any(
                token in joined
                for token in ("cloudflare", "captcha", "challenge", "blocked", "forbidden")
            ):
                blockers.append(joined[:120])
            elif entry.get("kind") == "tool" and entry.get("status") == "error":
                blockers.append(joined[:120] or f"{entry.get('tool_name', 'tool')} failed")
        return blockers

    def _last_successful_action(self, entries: list[dict[str, Any]]) -> str:
        for entry in reversed(entries):
            if entry.get("kind") == "tool" and entry.get("status") == "success":
                tool_name = str(entry.get("tool_name", "unknown")).strip() or "unknown"
                args = entry.get("tool_args", {}) or {}
                for key in ("url", "selector", "text", "xpath", "element_ref", "player_iframe_url"):
                    if args.get(key):
                        return f"{tool_name} on {key}={args[key]}"
                return tool_name
            if entry.get("kind") == "navigation" and entry.get("url"):
                return f"navigate to {entry['url']}"
        return ""

    def _next_best_move(self, entries: list[dict[str, Any]], blockers: list[str]) -> str:
        if blockers:
            return "wait, verify access state, and avoid repeating the blocked step"
        if not entries:
            if self._signals["critical_links"]:
                return "prioritize remembered critical links before broad page scans"
            return "start with a page context or navigation tool to gather fresh evidence"
        last = entries[-1]
        if last.get("kind") == "navigation":
            return "inspect the loaded page and identify the next actionable element"
        if last.get("kind") == "tool" and last.get("status") == "success":
            if self._signals["stream_urls"]:
                return "verify stream stability and continue with the next distinct server/source"
            if self._signals["server_frontier"]:
                return "continue the remembered server/source frontier before broad discovery"
            if self._signals["activation_targets"]:
                return "choose an exact remembered activation target and verify the post-action state"
            return "build on the last successful action and verify whether new streams or targets appeared"
        if last.get("kind") == "tool":
            if self._signals["server_frontier"]:
                return "try the next remembered server/source candidate instead of repeating the failed step"
            if self._signals["selectors"]:
                return "try a different remembered selector/xpath before another full-page scan"
            return "try a different locator or inspect the page before retrying the same action"
        return "continue from the freshest live-page evidence"
