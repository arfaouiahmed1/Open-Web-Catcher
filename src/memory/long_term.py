"""Long-term site memory for cross-run extraction hints."""

from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from src.utils.observability import RunTrace

_PROFILE_VERSION = 1
_PROFILE_ARRAY_LIMITS = {
    "selectors": 64,
    "pagination_url_patterns": 32,
    "url_patterns": 60,
    "navigation_hints": 60,
    "critical_links": 600,
    "server_labels": 220,
    "stream_hosts": 160,
    "ui_signals": 40,
    "hosting_candidate_urls": 900,
    "server_records": 420,
    "server_screenshots": 360,
    "server_stream_urls": 900,
    "activated_servers": 260,
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


def _build_profile_key(domain: str, page_type: str) -> str:
    return f"{domain}::{page_type}"


def _default_profile(domain: str, page_type: str) -> dict[str, Any]:
    return {
        "domain": domain,
        "page_type": page_type,
        "revision": 0,
        "updated_at": "",
        "updated_by": "",
        "last_refresh_reason": "",
        "ui_change_detected": False,
        "ui_change_notes": [],
        "selectors": [],
        "pagination_url_patterns": [],
        "url_patterns": [],
        "navigation_hints": [],
        "critical_links": [],
        "server_labels": [],
        "stream_hosts": [],
        "ui_signals": [],
        "hosting_candidate_urls": [],
        "server_records": [],
        "server_screenshots": [],
        "server_stream_urls": [],
        "activated_servers": [],
    }


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


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class LongTermMemory:
    """Stores reusable site-playbook hints across extraction runs.

    This is not classic RAG. It is a structured site-memory store: successful
    tool sequences, repeated selectors, server labels, stream hosts, and
    recurring failure patterns grouped by domain and page type.
    """

    def __init__(self, db_path: str = "data/site_memory.db", profiles_path: str | None = None) -> None:
        self.db_path = db_path
        db_file = Path(db_path)
        db_file.parent.mkdir(parents=True, exist_ok=True)
        if profiles_path:
            self._profiles_path = Path(profiles_path)
        else:
            self._profiles_path = db_file.with_name(f"{db_file.stem}_profiles.json")
        self._profiles_path.parent.mkdir(parents=True, exist_ok=True)
        self._profile_lock = Lock()
        self._bootstrap()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path, check_same_thread=False)

    def _bootstrap(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS site_memory_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    domain TEXT NOT NULL,
                    page_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    url TEXT NOT NULL,
                    success INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def save_pattern(self, domain: str, pattern_type: str, data: dict[str, Any]) -> None:
        payload = dict(data)
        payload.setdefault("pattern_type", pattern_type)
        self.remember(
            url=f"https://{domain}",
            page_type=pattern_type,
            status=str(payload.get("status", "unknown")),
            payload=payload,
            run_id=str(payload.get("run_id", "")),
        )

    def get_patterns(self, domain: str, pattern_type: str | None = None) -> list[dict[str, Any]]:
        rows = self._fetch_entries(domain=domain, page_type=pattern_type, limit=25)
        return [row["data"] for row in rows]

    def list_profiles(
        self,
        *,
        domain: str | None = None,
        page_type: str | None = None,
        limit: int = 25,
    ) -> list[dict[str, Any]]:
        normalized_domain = _normalize_domain(domain or "") if domain else ""
        normalized_page_type = str(page_type or "").strip()
        with self._profile_lock:
            store = self._load_profiles_store()
        profiles = list(store["profiles"].values())
        if normalized_domain:
            profiles = [profile for profile in profiles if profile.get("domain") == normalized_domain]
        if normalized_page_type:
            profiles = [profile for profile in profiles if profile.get("page_type") == normalized_page_type]
        profiles.sort(key=lambda item: str(item.get("updated_at", "")), reverse=True)
        capped = profiles[: max(int(limit or 1), 1)]
        return [json.loads(json.dumps(item)) for item in capped]

    def get_profile(self, *, url: str, page_type: str) -> dict[str, Any]:
        domain = _normalize_domain(url)
        normalized_page_type = str(page_type or "").strip()
        if not domain or not normalized_page_type:
            return {}
        key = _build_profile_key(domain, normalized_page_type)
        with self._profile_lock:
            store = self._load_profiles_store()
            profile = store["profiles"].get(key)
            if profile is None:
                return {}
            return json.loads(json.dumps(profile))

    def upsert_profile(
        self,
        *,
        url: str,
        page_type: str,
        patch: dict[str, Any],
        source: str = "agent_auto",
        reason: str = "",
        replace: bool = False,
    ) -> dict[str, Any]:
        domain = _normalize_domain(url)
        normalized_page_type = str(page_type or "").strip()
        if not domain or not normalized_page_type:
            return {}

        key = _build_profile_key(domain, normalized_page_type)
        now = datetime.utcnow().isoformat()

        with self._profile_lock:
            store = self._load_profiles_store()
            existing = dict(store["profiles"].get(key) or _default_profile(domain, normalized_page_type))
            merged = dict(existing)
            changed = False

            for field, max_items in _PROFILE_ARRAY_LIMITS.items():
                existing_values = _coerce_string_list(existing.get(field, []))
                incoming_values = _coerce_string_list((patch or {}).get(field, []))
                if replace and field in (patch or {}):
                    next_values = incoming_values[:max_items]
                elif incoming_values:
                    next_values = _dedupe_keep_order([*existing_values, *incoming_values])[:max_items]
                else:
                    next_values = existing_values[:max_items]
                merged[field] = next_values
                if next_values != existing_values:
                    changed = True

            explicit_ui_change = bool((patch or {}).get("ui_change_detected", False))
            if explicit_ui_change:
                merged["ui_change_detected"] = True
                changed = True

            old_signature = set(_coerce_string_list(existing.get("selectors", [])) + _coerce_string_list(existing.get("url_patterns", [])))
            incoming_signature = set(_coerce_string_list((patch or {}).get("selectors", [])) + _coerce_string_list((patch or {}).get("url_patterns", [])))
            if old_signature and incoming_signature:
                overlap = len(old_signature & incoming_signature) / max(len(incoming_signature), 1)
                if overlap < 0.35:
                    merged["ui_change_detected"] = True
                    ui_note = f"structural drift detected (signature overlap={overlap:.2f})"
                    merged["ui_change_notes"] = _dedupe_keep_order(
                        _coerce_string_list(existing.get("ui_change_notes", [])) + [ui_note]
                    )[:6]
                    changed = True

            patch_notes = _coerce_string_list((patch or {}).get("ui_change_notes", []))
            if patch_notes:
                merged["ui_change_notes"] = _dedupe_keep_order(
                    _coerce_string_list(existing.get("ui_change_notes", [])) + patch_notes
                )[:6]
                changed = True

            reason_text = str(reason or "").strip()
            if reason_text and reason_text != str(existing.get("last_refresh_reason", "")):
                merged["last_refresh_reason"] = reason_text
                changed = True

            merged.setdefault("domain", domain)
            merged.setdefault("page_type", normalized_page_type)

            if changed:
                merged["revision"] = _safe_int(existing.get("revision", 0), 0) + 1
                merged["updated_at"] = now
                merged["updated_by"] = str(source or "agent_auto")
            else:
                merged["revision"] = _safe_int(existing.get("revision", 0), 0)
                merged["updated_at"] = str(existing.get("updated_at", ""))
                merged["updated_by"] = str(existing.get("updated_by", ""))

            store["profiles"][key] = merged
            self._save_profiles_store(store)
            return json.loads(json.dumps(merged))

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
        domain = _normalize_domain(url)
        data = build_site_memory_entry(
            url=url,
            page_type=page_type,
            status=status,
            payload=payload or {},
            trace=trace,
            actor=actor,
            short_memory_summary=short_memory_summary,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO site_memory_entries
                (domain, page_type, status, run_id, url, success, data, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    domain,
                    page_type,
                    status,
                    run_id,
                    url,
                    1 if data["success"] else 0,
                    json.dumps(data, ensure_ascii=False),
                    datetime.utcnow().isoformat(),
                ),
            )
            conn.commit()

        if data.get("success"):
            profile_patch = self._build_profile_patch(entry=data, payload=payload or {})
            if profile_patch:
                self.upsert_profile(
                    url=url,
                    page_type=page_type,
                    patch=profile_patch,
                    source="agent_auto",
                    reason=f"auto refresh from {page_type} ({status})",
                    replace=False,
                )
        return data

    def build_prompt_context(self, url: str, page_type: str, limit: int = 6) -> str:
        domain = _normalize_domain(url)
        rows = self._fetch_entries(domain=domain, page_type=page_type, limit=limit)
        if not rows:
            rows = self._fetch_entries(domain=domain, page_type=None, limit=max(limit, 4))
        if not rows:
            return ""

        profile = self.get_profile(url=url, page_type=page_type)
        if not profile:
            domain_profiles = self.list_profiles(domain=domain, page_type=page_type, limit=1)
            profile = domain_profiles[0] if domain_profiles else {}

        tool_counts: Counter[str] = Counter()
        target_counts: Counter[str] = Counter()
        selector_counts: Counter[str] = Counter()
        server_counts: Counter[str] = Counter()
        stream_host_counts: Counter[str] = Counter()
        url_pattern_counts: Counter[str] = Counter()
        pagination_counts: Counter[str] = Counter()
        critical_link_counts: Counter[str] = Counter()
        latest_step_playbook: list[str] = []
        failure_patterns: list[str] = []
        successes = 0

        for row in rows:
            data = row["data"]
            successes += 1 if data.get("success") else 0
            tool_counts.update(data.get("tool_sequence", []))
            target_counts.update(data.get("navigation_targets", []))
            selector_counts.update(data.get("selectors", []))
            server_counts.update(data.get("server_labels", []))
            stream_host_counts.update(data.get("stream_hosts", []))
            url_pattern_counts.update(data.get("url_patterns", []))
            pagination_counts.update(data.get("pagination_patterns", []))
            critical_link_counts.update(data.get("critical_links", []))
            if not latest_step_playbook and data.get("success"):
                latest_step_playbook = _coerce_string_list(data.get("tool_steps", []))
            if not data.get("success") and data.get("result_summary"):
                failure_patterns.append(str(data["result_summary"]))

        lines = [
            "SITE MEMORY HINTS",
            "Use these only as hints. Re-verify on the live page before trusting them.",
            f"- domain: `{domain}`",
            f"- page type focus: `{page_type}`",
            f"- recent runs remembered: `{len(rows)}`",
            f"- recent successes: `{successes}` / `{len(rows)}`",
        ]

        if tool_counts:
            lines.append(
                "- often useful tools: "
                + ", ".join(f"`{tool}` x{count}" for tool, count in tool_counts.most_common(5))
            )
        if latest_step_playbook:
            lines.append(
                "- latest successful step playbook: "
                + " -> ".join(f"`{step}`" for step in latest_step_playbook[:8])
            )
        if target_counts:
            lines.append(
                "- repeated navigation targets: "
                + ", ".join(f"`{target}`" for target, _ in target_counts.most_common(4))
            )
        if selector_counts:
            lines.append(
                "- repeated selectors/text targets: "
                + ", ".join(f"`{target}`" for target, _ in selector_counts.most_common(4))
            )
        if server_counts:
            lines.append(
                "- repeated server labels: "
                + ", ".join(f"`{label}`" for label, _ in server_counts.most_common(4))
            )
        if stream_host_counts:
            lines.append(
                "- previously seen stream hosts: "
                + ", ".join(f"`{host}`" for host, _ in stream_host_counts.most_common(4))
            )
        if url_pattern_counts:
            lines.append(
                "- repeated url patterns: "
                + ", ".join(f"`{pattern}`" for pattern, _ in url_pattern_counts.most_common(4))
            )
        if pagination_counts:
            lines.append(
                "- repeated pagination url patterns: "
                + ", ".join(f"`{pattern}`" for pattern, _ in pagination_counts.most_common(4))
            )
        if critical_link_counts:
            lines.append(
                "- critical links seen before: "
                + ", ".join(f"`{link}`" for link, _ in critical_link_counts.most_common(5))
            )
        if profile:
            lines.append(
                f"- memory profile revision: `{_safe_int(profile.get('revision', 0), 0)}`"
            )
            if profile.get("selectors"):
                lines.append(
                    "- remembered selectors/actions: "
                    + ", ".join(f"`{item}`" for item in _coerce_string_list(profile.get("selectors", []))[:6])
                )
            if profile.get("pagination_url_patterns"):
                lines.append(
                    "- remembered pagination url patterns: "
                    + ", ".join(
                        f"`{item}`" for item in _coerce_string_list(profile.get("pagination_url_patterns", []))[:4]
                    )
                )
            if profile.get("url_patterns"):
                lines.append(
                    "- remembered route/url patterns: "
                    + ", ".join(f"`{item}`" for item in _coerce_string_list(profile.get("url_patterns", []))[:5])
                )
            if profile.get("navigation_hints"):
                lines.append(
                    "- remembered navigation playbook: "
                    + ", ".join(f"`{item}`" for item in _coerce_string_list(profile.get("navigation_hints", []))[:5])
                )
            if profile.get("critical_links"):
                lines.append(
                    "- remembered critical links: "
                    + ", ".join(f"`{item}`" for item in _coerce_string_list(profile.get("critical_links", []))[:6])
                )
            if profile.get("hosting_candidate_urls"):
                landing_candidates = _coerce_string_list(profile.get("hosting_candidate_urls", []))
                lines.append(
                    f"- remembered landing hosting candidates: `{len(landing_candidates)}`"
                    + (
                        " (sample: "
                        + ", ".join(f"`{item}`" for item in landing_candidates[:5])
                        + ")"
                        if landing_candidates
                        else ""
                    )
                )
            if profile.get("server_records"):
                server_records = _coerce_string_list(profile.get("server_records", []))
                parsed_labels: list[str] = []
                for raw in server_records[:12]:
                    try:
                        parsed = json.loads(raw)
                    except Exception:
                        parsed = {}
                    label = str(parsed.get("label", "")).strip() if isinstance(parsed, dict) else ""
                    if label:
                        parsed_labels.append(label)
                lines.append(
                    f"- remembered server snapshots: `{len(server_records)}`"
                    + (
                        " (sample labels: "
                        + ", ".join(f"`{item}`" for item in _dedupe_keep_order(parsed_labels)[:6])
                        + ")"
                        if parsed_labels
                        else ""
                    )
                )
            if profile.get("activated_servers"):
                lines.append(
                    "- often activated servers: "
                    + ", ".join(f"`{item}`" for item in _coerce_string_list(profile.get("activated_servers", []))[:8])
                )
            if profile.get("server_stream_urls"):
                lines.append(
                    "- remembered per-server stream urls: "
                    + ", ".join(f"`{item}`" for item in _coerce_string_list(profile.get("server_stream_urls", []))[:5])
                )
            if profile.get("ui_change_detected"):
                notes = _coerce_string_list(profile.get("ui_change_notes", []))
                lines.append(
                    "- ui change warning: "
                    + ("; ".join(f"`{item}`" for item in notes[:2]) if notes else "`possible structural drift from recent runs`")
                )
            if profile.get("last_refresh_reason"):
                lines.append(f"- last memory refresh reason: `{profile['last_refresh_reason']}`")

        lines.append(
            "- memory-first policy: start from remembered selectors/patterns and only escalate to heavy full-page scans when hints fail or page structure changed"
        )
        if failure_patterns:
            lines.append(
                "- recent failure patterns: "
                + "; ".join(f"`{pattern[:120]}`" for pattern in failure_patterns[:3])
            )
        return "\n".join(lines)

    def close(self) -> None:
        """Maintained for backwards compatibility."""

    def _fetch_entries(self, *, domain: str, page_type: str | None, limit: int) -> list[dict[str, Any]]:
        query = """
            SELECT page_type, status, success, data, created_at
            FROM site_memory_entries
            WHERE domain = ?
        """
        params: list[Any] = [domain]
        if page_type:
            query += " AND page_type = ?"
            params.append(page_type)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(max(int(limit or 1), 1))

        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            {
                "page_type": row[0],
                "status": row[1],
                "success": bool(row[2]),
                "data": json.loads(row[3]),
                "created_at": row[4],
            }
            for row in rows
        ]

    def _load_profiles_store(self) -> dict[str, Any]:
        default_store = {"version": _PROFILE_VERSION, "profiles": {}}
        if not self._profiles_path.exists():
            return default_store
        try:
            raw = self._profiles_path.read_text(encoding="utf-8")
            loaded = json.loads(raw or "{}")
            if not isinstance(loaded, dict):
                return default_store
            profiles = loaded.get("profiles")
            if not isinstance(profiles, dict):
                profiles = {}
            return {
                "version": _safe_int(loaded.get("version", _PROFILE_VERSION), _PROFILE_VERSION),
                "profiles": profiles,
            }
        except Exception:
            return default_store

    def _save_profiles_store(self, store: dict[str, Any]) -> None:
        payload = {
            "version": _PROFILE_VERSION,
            "profiles": store.get("profiles", {}),
        }
        temp_path = self._profiles_path.with_suffix(self._profiles_path.suffix + ".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(self._profiles_path)

    def _build_profile_patch(self, *, entry: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        patch: dict[str, list[str]] = {
            "selectors": _coerce_string_list(entry.get("selectors", [])),
            "pagination_url_patterns": _coerce_string_list(entry.get("pagination_patterns", [])),
            "url_patterns": _coerce_string_list(entry.get("url_patterns", [])),
            "navigation_hints": _coerce_string_list(entry.get("navigation_targets", [])),
            "critical_links": _coerce_string_list(entry.get("critical_links", [])),
            "server_labels": _coerce_string_list(entry.get("server_labels", [])),
            "stream_hosts": _coerce_string_list(entry.get("stream_hosts", [])),
            "ui_signals": [],
            "hosting_candidate_urls": _coerce_string_list(entry.get("hosting_candidate_urls", [])),
            "server_records": _coerce_string_list(entry.get("server_records", [])),
            "server_screenshots": _coerce_string_list(entry.get("server_screenshots", [])),
            "server_stream_urls": _coerce_string_list(entry.get("server_stream_urls", [])),
            "activated_servers": _coerce_string_list(entry.get("activated_servers", [])),
        }
        patch["navigation_hints"].extend(_coerce_string_list(entry.get("tool_steps", [])))

        for target in patch["navigation_hints"]:
            if "=" not in target:
                continue
            candidate = str(target).split("=", 1)[1].strip()
            if candidate.startswith(("http://", "https://")):
                patch["critical_links"].append(candidate)
                patch["url_patterns"].append(_generalize_url_pattern(candidate))
                if _looks_like_pagination_url(candidate):
                    patch["pagination_url_patterns"].append(_generalize_url_pattern(candidate))

        site_patterns = payload.get("site_patterns", {}) if isinstance(payload, dict) else {}
        if isinstance(site_patterns, dict):
            for key in ("hosting_url_pattern", "listing_url_pattern", "url_pattern"):
                value = site_patterns.get(key)
                if value:
                    patch["url_patterns"].append(str(value))
            pagination = site_patterns.get("pagination", {})
            if isinstance(pagination, dict):
                pagination_pattern = pagination.get("url_pattern")
                if pagination_pattern:
                    patch["pagination_url_patterns"].append(str(pagination_pattern))

        run_memory = payload.get("run_memory", {}) if isinstance(payload, dict) else {}
        if isinstance(run_memory, dict):
            common_memory = run_memory.get("common", run_memory)
            if isinstance(common_memory, dict):
                patch["selectors"].extend(_coerce_string_list(common_memory.get("selectors", [])))
                patch["pagination_url_patterns"].extend(
                    _coerce_string_list(common_memory.get("pagination_patterns", []))
                )
                patch["url_patterns"].extend(_coerce_string_list(common_memory.get("url_patterns", [])))
                patch["critical_links"].extend(_coerce_string_list(common_memory.get("critical_links", [])))
                patch["server_labels"].extend(_coerce_string_list(common_memory.get("server_labels", [])))
                patch["stream_hosts"].extend(_coerce_string_list(common_memory.get("stream_hosts", [])))

            patch["hosting_candidate_urls"].extend(
                _coerce_string_list(run_memory.get("hosting_candidate_urls", []))
            )
            patch["server_records"].extend(_coerce_string_list(run_memory.get("server_records", [])))
            patch["server_screenshots"].extend(
                _coerce_string_list(run_memory.get("server_screenshots", []))
            )
            patch["server_stream_urls"].extend(
                _coerce_string_list(run_memory.get("server_stream_urls", []))
            )
            patch["activated_servers"].extend(_coerce_string_list(run_memory.get("activated_servers", [])))

            agent_specific = run_memory.get("agent_specific", {})
            if isinstance(agent_specific, dict):
                for scoped in agent_specific.values():
                    if not isinstance(scoped, dict):
                        continue
                    patch["hosting_candidate_urls"].extend(
                        _coerce_string_list(scoped.get("hosting_candidate_urls", []))
                    )
                    patch["server_records"].extend(_coerce_string_list(scoped.get("server_records", [])))
                    patch["server_screenshots"].extend(
                        _coerce_string_list(scoped.get("server_screenshots", []))
                    )
                    patch["server_stream_urls"].extend(
                        _coerce_string_list(scoped.get("server_stream_urls", []))
                    )
                    patch["activated_servers"].extend(
                        _coerce_string_list(scoped.get("activated_servers", []))
                    )

        hosting_pages = payload.get("hosting_pages", []) if isinstance(payload, dict) else []
        if isinstance(hosting_pages, list):
            for candidate in hosting_pages:
                if isinstance(candidate, dict):
                    candidate_url = str(candidate.get("url") or candidate.get("href") or "").strip()
                elif isinstance(candidate, str):
                    candidate_url = str(candidate).strip()
                else:
                    candidate_url = ""
                if not candidate_url.startswith(("http://", "https://")):
                    continue
                patch["hosting_candidate_urls"].append(candidate_url)
                patch["critical_links"].append(candidate_url)
                patch["url_patterns"].append(_generalize_url_pattern(candidate_url))
                if _looks_like_pagination_url(candidate_url):
                    patch["pagination_url_patterns"].append(_generalize_url_pattern(candidate_url))

        servers = payload.get("servers", []) if isinstance(payload, dict) else []
        if isinstance(servers, list):
            for index, server in enumerate(servers):
                if not isinstance(server, dict):
                    continue
                label = str(server.get("label") or server.get("name") or server.get("server") or f"server_{index + 1}").strip()
                if label:
                    patch["server_labels"].append(label)

                screenshot_url = str(server.get("screenshot_url") or "").strip()
                if screenshot_url:
                    patch["server_screenshots"].append(screenshot_url)

                embedded_url = str(server.get("embedded_url") or "").strip()
                if embedded_url.startswith(("http://", "https://")):
                    patch["critical_links"].append(embedded_url)
                    patch["url_patterns"].append(_generalize_url_pattern(embedded_url))

                stream_urls: list[str] = []
                for field in ("m3u8_urls", "mpd_urls", "mp4_urls"):
                    values = server.get(field, [])
                    if not isinstance(values, list):
                        continue
                    for value in values:
                        stream_candidate = str(value or "").strip()
                        if stream_candidate:
                            stream_urls.append(stream_candidate)
                primary_stream = str(server.get("primary_stream") or "").strip()
                if primary_stream:
                    stream_urls.append(primary_stream)

                unique_streams = _dedupe_keep_order(stream_urls)
                patch["server_stream_urls"].extend(unique_streams)
                for stream_candidate in unique_streams:
                    patch["critical_links"].append(stream_candidate)
                    patch["stream_hosts"].append(_normalize_domain(stream_candidate))

                status = str(server.get("status") or "").strip().lower()
                player_state = str(server.get("player_state") or "").strip().lower()
                server_up = bool(server.get("server_up"))
                if label and (
                    server_up
                    or status in {"success", "partial", "active"}
                    or player_state in {"playing", "loading", "ready"}
                ):
                    patch["activated_servers"].append(label)

                server_record = {
                    "label": label,
                    "status": status or ("success" if server_up else "unknown"),
                    "player_state": player_state or "unknown",
                    "server_up": server_up,
                    "stream_count": len(unique_streams),
                    "primary_stream": primary_stream,
                    "embedded_url": embedded_url,
                    "screenshot_url": screenshot_url,
                }
                patch["server_records"].append(
                    json.dumps(server_record, ensure_ascii=False, sort_keys=True)
                )

        payload_urls = _extract_urls_from_payload(payload)
        patch["critical_links"].extend(payload_urls)
        patch["url_patterns"].extend([_generalize_url_pattern(item) for item in payload_urls])
        patch["pagination_url_patterns"].extend(
            [_generalize_url_pattern(item) for item in payload_urls if _looks_like_pagination_url(item)]
        )

        for field, max_items in _PROFILE_ARRAY_LIMITS.items():
            patch[field] = _dedupe_keep_order([value for value in patch.get(field, []) if value])[:max_items]

        return {field: values for field, values in patch.items() if values}

    def _result_summary(self, page_type: str, status: str, payload: dict[str, Any]) -> str:
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

    tool_limit = 24
    tool_step_limit = 80
    navigation_limit = 80 if is_landing else 36
    selector_limit = 72 if is_landing else 52 if is_stream_page else 24
    url_pattern_limit = 120 if is_landing else 80 if is_stream_page else 28
    pagination_limit = 64 if is_landing else 24
    critical_limit = 1200 if is_landing else 700 if is_stream_page else 120
    server_label_limit = 260 if is_stream_page else 120
    stream_host_limit = 220 if is_stream_page else 80
    hosting_candidate_limit = 1200 if is_landing else 320
    server_record_limit = 420 if is_stream_page else 120
    server_stream_limit = 1200 if is_stream_page else 180
    server_screenshot_limit = 420 if is_stream_page else 120
    activated_limit = 260 if is_stream_page else 100

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
        "llm_notes": _dedupe_keep_order(llm_notes)[:4],
        "short_memory_summary": short_memory_summary[:1200],
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
