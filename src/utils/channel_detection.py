"""Shared channel/broadcast metadata detection helpers."""

from __future__ import annotations

import re
from typing import Any

CHANNEL_PATTERNS: list[tuple[str, tuple[str, ...], str]] = [
    ("beIN SPORTS", ("bein sports", "beinsports", "be in sports", "bein", "bein sport", "bein sports premium", "bein sports english", "bein sports mena"), "https://www.beinsports.com/"),
    ("Sky Sports", ("sky sports", "skysports", "sky sport"), "https://www.skysports.com/"),
    ("Sky News", ("sky news", "skynews"), "https://news.sky.com/"),
    ("CNN", ("cnn", "cnn international", "cnn news"), "https://www.cnn.com/"),
    ("CNBC", ("cnbc", "cnbc europe", "cnbc asia"), "https://www.cnbc.com/"),
    ("BBC News", ("bbc news", "bbc world news"), "https://www.bbc.com/news"),
    ("BBC One", ("bbc one", "bbc1", "bbc 1"), "https://www.bbc.co.uk/bbcone"),
    ("ITV", ("itv", "itv1", "itv 1"), "https://www.itv.com/"),
    ("Channel 4", ("channel 4", "channel4", "c4"), "https://www.channel4.com/"),
    ("Al Jazeera", ("al jazeera", "aljazeera", "al jazeera english", "aljazeera english"), "https://www.aljazeera.com/"),
    ("NBC Sports", ("nbc sports", "nbcsports", "nbc sport"), "https://www.nbcsports.com/"),
    ("FOX Sports", ("fox sports", "foxsports", "fox sport"), "https://www.foxsports.com/"),
    ("CBS Sports", ("cbs sports", "cbssports", "cbs sport"), "https://www.cbssports.com/"),
    ("ESPN", ("espn", "espn+", "espn plus"), "https://www.espn.com/"),
    ("TNT Sports", ("tnt sports", "tntsports", "bt sport", "bt sports"), "https://www.tntsports.co.uk/"),
    ("Eurosport", ("eurosport",), "https://www.eurosport.com/"),
    ("DAZN", ("dazn",), "https://www.dazn.com/"),
    ("Canal+", ("canal+", "canal plus"), "https://www.canalplus.com/"),
    ("RMC Sport", ("rmc sport", "rmc sports"), "https://rmcsport.bfmtv.com/"),
    ("SuperSport", ("supersport", "super sport"), "https://supersport.com/"),
    ("Star Sports", ("star sports", "starsports", "star sport"), "https://www.hotstar.com/"),
    ("Sony Sports", ("sony sports", "sony ten", "sony liv sports", "sony sports network"), "https://www.sonysportsnetwork.com/"),
    ("Astro SuperSport", ("astro supersport", "astro super sport"), "https://www.astro.com.my/"),
    ("Optus Sport", ("optus sport", "optus sports"), "https://sport.optus.com.au/"),
    ("TSN", ("tsn", "the sports network"), "https://www.tsn.ca/"),
    ("Sportsnet", ("sportsnet", "sports net"), "https://www.sportsnet.ca/"),
    ("Viaplay Sports", ("viaplay sports", "viaplay sport"), "https://viaplay.com/"),
    ("Ziggo Sport", ("ziggo sport", "ziggo sports"), "https://www.ziggosport.nl/"),
    ("Eleven Sports", ("eleven sports", "eleven sport"), "https://elevensports.com/"),
    ("Arena Sport", ("arena sport", "arena sports"), ""),
    ("Sport Klub", ("sport klub", "sportklub", "sport club"), ""),
    ("SSC Sports", ("ssc sports", "ssc sport", "saudi sports company"), ""),
    ("Abu Dhabi Sports", ("abu dhabi sports", "ad sports", "adsports"), "https://adsports.ae/"),
    ("Dubai Sports", ("dubai sports", "dubai sport"), "https://www.dubaisports.ae/"),
    ("Al Kass", ("al kass", "alkass", "al kass sports"), "https://www.alkass.net/"),
    ("MBC", ("mbc", "mbc action", "mbc masr", "mbc iraq", "mbc shahid"), "https://www.mbc.net/"),
    ("OSN", ("osn", "osn sports", "osn sport"), "https://www.osn.com/"),
    ("F1 TV", ("f1 tv", "formula 1", "formula1", "sky f1", "f1 live"), "https://www.formula1.com/"),
    ("NFL Network", ("nfl network",), "https://www.nfl.com/network/"),
    ("MLB Network", ("mlb network",), "https://www.mlb.com/network"),
    ("NBA TV", ("nba tv", "nbatv"), "https://www.nba.com/watch/nba-tv"),
    ("UFC Fight Pass", ("ufc fight pass", "fight pass"), "https://welcome.ufcfightpass.com/"),
]

_GENERIC_CHANNEL_LABELS = {
    "1",
    "2",
    "3",
    "4",
    "channel",
    "channels",
    "default",
    "english",
    "hd",
    "live",
    "main",
    "news",
    "player",
    "sd",
    "server",
    "server 1",
    "server 2",
    "source",
    "source 1",
    "source 2",
    "sports",
    "stream",
    "stream 1",
    "stream 2",
}

_UNKNOWN_CHANNEL_MARKER_RE = re.compile(
    r"\b(tv|sports?|news|network|canal|channel|sport)\b",
    re.IGNORECASE,
)


def _normalize_lookup_text(value: str) -> str:
    return re.sub(r"[^a-z0-9+]+", " ", str(value or "").lower()).strip()


def _canonical_known_channel(value: str) -> str:
    lookup = _normalize_lookup_text(value)
    if not lookup or lookup in _GENERIC_CHANNEL_LABELS:
        return ""
    for canonical, aliases, _ in CHANNEL_PATTERNS:
        for alias in (canonical, *aliases):
            alias_lookup = _normalize_lookup_text(alias)
            if not alias_lookup:
                continue
            # Accept direct aliases and numbered/HD variants like beIN SPORTS 1 HD.
            pattern = rf"(?<![a-z0-9]){re.escape(alias_lookup)}(?:\s+(?:\d{{1,2}}|hd|uhd|fhd|4k|premium|extra|max|english|arabic|fr|en|mena))*?(?![a-z0-9])"
            if re.search(pattern, lookup):
                return canonical
    return ""


def normalize_channel_name(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""

    known = _canonical_known_channel(raw)
    if known:
        return known

    cleaned = re.sub(r"\s+", " ", raw).strip(" -|:")
    cleaned_lookup = _normalize_lookup_text(cleaned)
    if cleaned_lookup in _GENERIC_CHANNEL_LABELS:
        return ""
    # Keep unknown names only when they look like a real broadcaster label.
    # Generic server/source/language labels must not become channel metadata.
    if (
        _UNKNOWN_CHANNEL_MARKER_RE.search(cleaned)
        and re.fullmatch(r"[A-Za-z0-9+ .'-]{3,60}", cleaned)
        and not re.fullmatch(r"(server|source|stream|channel)\s*\d+", cleaned, flags=re.IGNORECASE)
    ):
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
