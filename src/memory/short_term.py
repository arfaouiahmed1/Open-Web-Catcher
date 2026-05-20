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
    path = re.sub(r"/\d+(?=/|$)", "/{n}", path)
    path = re.sub(r"/[0-9a-fA-F]{8,}(?=/|$)", "/{id}", path)
    path = re.sub(r"/[A-Za-z0-9_-]{24,}(?=/|$)", "/{token}", path)

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
                elif isinstance(value, (dict, list, tuple)):
                    _walk(value)
        elif isinstance(node, (list, tuple)):
            for item in node:
                if len(found) >= limit:
                    break
                _walk(item)

    _walk(payload)
    return _dedupe_keep_order(found)


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
            "server_records": [],
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
            self._capture_hosting_candidates(payload, base_url=base_url)
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
        if run_memory.get("page_type") in {"hosting_page", "embedded_page"} and run_memory.get(
            "server_records"
        ):
            lines.append(f"- server records remembered: {len(run_memory['server_records'])}")
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
            match_records = run_memory.get("match_records", [])
            if match_records:
                lines.append(f"- landing match records remembered: `{len(match_records)}`")
        if (page_type or self.page_type) in {"hosting_page", "embedded_page"}:
            server_records = run_memory.get("server_records", [])
            lines.append(
                "- server snapshots remembered: "
                + (f"`{len(server_records)}`" if server_records else "`none yet`")
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
        }

        landing_specific = {
            "hosting_candidate_urls": list(self._signals["hosting_candidate_urls"]),
            "match_records": list(self._signals["match_records"]),
        }
        hosting_specific = {
            "server_records": list(self._signals["server_records"]),
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
            "iframe_urls": common["iframe_urls"],
            "server_records": hosting_specific["server_records"],
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
            "server_records": 220,
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
        for key in ("hosting_pages", "match_candidates", "top_match_candidates"):
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
                if resolved:
                    discovered.append(resolved)
                    if isinstance(entry, dict):
                        record = {
                            "url": resolved,
                            "title": str(entry.get("title") or "")[:180],
                            "participants": str(entry.get("participants") or "")[:160],
                            "status": str(entry.get("status") or "unknown")[:40],
                            "route": str(entry.get("route") or "")[:60],
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
            return "build on the last successful action and verify whether new streams or targets appeared"
        if last.get("kind") == "tool":
            if self._signals["selectors"]:
                return "try a different remembered selector/xpath before another full-page scan"
            return "try a different locator or inspect the page before retrying the same action"
        return "continue from the freshest live-page evidence"
