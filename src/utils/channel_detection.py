"""Shared channel/broadcast metadata detection helpers."""

from __future__ import annotations

import re
from typing import Any

CHANNEL_PATTERNS: list[tuple[str, tuple[str, ...], str]] = [
    ("beIN SPORTS", ("bein sports", "beinsports", "be in sports", "bein", "bein sport"), "https://www.beinsports.com/"),
    ("Sky Sports", ("sky sports", "skysports", "sky sport"), "https://www.skysports.com/"),
    ("NBC Sports", ("nbc sports", "nbcsports", "nbc sport"), "https://www.nbcsports.com/"),
    ("FOX Sports", ("fox sports", "foxsports", "fox sport"), "https://www.foxsports.com/"),
    ("ESPN", ("espn", "espn+", "espn plus"), "https://www.espn.com/"),
    ("TNT Sports", ("tnt sports", "tntsports", "bt sport", "bt sports"), "https://www.tntsports.co.uk/"),
    ("Eurosport", ("eurosport",), "https://www.eurosport.com/"),
    ("DAZN", ("dazn",), "https://www.dazn.com/"),
    ("Canal+", ("canal+", "canal plus"), "https://www.canalplus.com/"),
    ("F1 TV", ("f1 tv", "formula 1", "formula1", "sky f1", "f1 live"), "https://www.formula1.com/"),
    ("NFL Network", ("nfl network",), "https://www.nfl.com/network/"),
    ("MLB Network", ("mlb network",), "https://www.mlb.com/network"),
    ("NBA TV", ("nba tv", "nbatv"), "https://www.nba.com/watch/nba-tv"),
    ("UFC Fight Pass", ("ufc fight pass", "fight pass"), "https://welcome.ufcfightpass.com/"),
]


def normalize_channel_name(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    lowered = re.sub(r"\s+", " ", raw.lower())
    for canonical, aliases, _ in CHANNEL_PATTERNS:
        if lowered == canonical.lower() or lowered in aliases:
            return canonical
    cleaned = re.sub(r"\s+", " ", raw).strip(" -|:")
    if re.fullmatch(r"[A-Za-z0-9+ .'-]{2,60}", cleaned):
        return cleaned
    return ""


def rights_owner_reference_url(channel_name: str) -> str:
    normalized = normalize_channel_name(channel_name)
    for canonical, aliases, url in CHANNEL_PATTERNS:
        if normalized.lower() == canonical.lower() or normalized.lower() in aliases:
            return url
    return ""


def detect_channel_candidates(*values: Any) -> list[dict[str, Any]]:
    scores: dict[str, dict[str, Any]] = {}
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if not text:
            continue
        collapsed = re.sub(r"\s+", " ", text.lower())
        lowered = f" {collapsed} "
        for canonical, aliases, _ in CHANNEL_PATTERNS:
            for alias in (canonical.lower(), *aliases):
                alias_pattern = re.escape(alias)
                if not re.search(rf"(?<![a-z0-9]){alias_pattern}(?![a-z0-9])", lowered):
                    continue
                entry = scores.setdefault(
                    canonical,
                    {"channel_name": canonical, "score": 0, "evidence": []},
                )
                entry["score"] += 2 if canonical.lower() == alias else 1
                if text not in entry["evidence"]:
                    entry["evidence"].append(text[:240])
                break

        explicit_match = re.search(
            r"(?:channel|network|broadcast|live on|watch on|streaming on)\s*[:\-]?\s*([A-Za-z0-9+ .'-]{2,60})",
            text,
            flags=re.IGNORECASE,
        )
        if explicit_match:
            candidate = normalize_channel_name(explicit_match.group(1))
            if candidate:
                entry = scores.setdefault(
                    candidate,
                    {"channel_name": candidate, "score": 0, "evidence": []},
                )
                entry["score"] += 1
                if text not in entry["evidence"]:
                    entry["evidence"].append(text[:240])

    return sorted(scores.values(), key=lambda item: (-int(item["score"]), item["channel_name"]))


def best_channel_match(*values: Any) -> dict[str, Any]:
    candidates = detect_channel_candidates(*values)
    if not candidates:
        return {
            "channel_name": "",
            "channel_candidates": [],
            "channel_confidence": "low",
            "channel_detection_method": "",
        }
    top = candidates[0]
    score = int(top.get("score") or 0)
    confidence = "high" if score >= 4 else "medium" if score >= 2 else "low"
    return {
        "channel_name": str(top.get("channel_name") or ""),
        "channel_candidates": [str(item.get("channel_name") or "") for item in candidates[:6]],
        "channel_confidence": confidence,
        "channel_detection_method": "text_agent_signal",
        "channel_evidence": top.get("evidence", [])[:4],
    }


def collect_channel_text_fragments(values: list[Any]) -> list[str]:
    fragments: list[str] = []
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            text = value.strip()
            if text:
                fragments.append(text)
            continue
        if isinstance(value, dict):
            for key in (
                "title",
                "channel",
                "event_title",
                "ocr_text",
                "player_ocr_text",
                "session_summary",
                "label",
                "source",
                "role",
            ):
                text = str(value.get(key) or "").strip()
                if text:
                    fragments.append(text)
            continue
        if isinstance(value, (list, tuple, set)):
            fragments.extend(collect_channel_text_fragments(list(value)))
            continue
        text = str(value).strip()
        if text:
            fragments.append(text)
    return fragments
