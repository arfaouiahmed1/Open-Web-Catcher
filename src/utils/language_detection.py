"""Lightweight language/track detection for player server labels."""

from __future__ import annotations

import re
from typing import Any

_LANGUAGE_ALIASES: list[tuple[str, tuple[str, ...]]] = [
    ("English", ("english", "eng", "en", "us", "usa", "uk", "gb", "intl", "international")),
    ("Arabic", ("arabic", "ara", "ar", "mena")),
    ("French", ("french", "francais", "fr")),
    ("Spanish", ("spanish", "espanol", "es", "latam")),
    ("Portuguese", ("portuguese", "portugues", "pt", "br")),
    ("German", ("german", "deutsch", "de")),
    ("Italian", ("italian", "italiano", "it")),
    ("Turkish", ("turkish", "turkce", "tr")),
    ("Dutch", ("dutch", "nl")),
    ("Polish", ("polish", "pl")),
    ("Russian", ("russian", "ru")),
    ("Hindi", ("hindi", "hi")),
    ("Japanese", ("japanese", "jp", "ja")),
    ("Korean", ("korean", "kr", "ko")),
    ("Chinese", ("chinese", "cn", "zh")),
]

_FLAG_LANGUAGE_BY_COUNTRY = {
    "AE": "Arabic",
    "AR": "Spanish",
    "BR": "Portuguese",
    "CA": "English",
    "CN": "Chinese",
    "DE": "German",
    "DZ": "Arabic",
    "EG": "Arabic",
    "ES": "Spanish",
    "FR": "French",
    "GB": "English",
    "IT": "Italian",
    "JP": "Japanese",
    "KR": "Korean",
    "MA": "Arabic",
    "MX": "Spanish",
    "NL": "Dutch",
    "PL": "Polish",
    "PT": "Portuguese",
    "RU": "Russian",
    "SA": "Arabic",
    "TN": "Arabic",
    "TR": "Turkish",
    "US": "English",
}

_REGIONAL_INDICATOR_A = 0x1F1E6
_REGIONAL_INDICATOR_Z = 0x1F1FF


def _flatten_text(values: tuple[Any, ...]) -> list[str]:
    result: list[str] = []
    for value in values:
        if value is None:
            continue
        if isinstance(value, dict):
            result.extend(_flatten_text(tuple(value.values())))
            continue
        if isinstance(value, (list, tuple, set)):
            result.extend(_flatten_text(tuple(value)))
            continue
        text = str(value).strip()
        if text:
            result.append(text)
    return result


def _country_code_from_flag_pair(first: str, second: str) -> str:
    first_code = ord(first)
    second_code = ord(second)
    if not (
        _REGIONAL_INDICATOR_A <= first_code <= _REGIONAL_INDICATOR_Z
        and _REGIONAL_INDICATOR_A <= second_code <= _REGIONAL_INDICATOR_Z
    ):
        return ""
    return chr(first_code - _REGIONAL_INDICATOR_A + ord("A")) + chr(
        second_code - _REGIONAL_INDICATOR_A + ord("A")
    )


def _flag_language_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    chars = list(str(text or ""))
    for index in range(len(chars) - 1):
        country_code = _country_code_from_flag_pair(chars[index], chars[index + 1])
        language = _FLAG_LANGUAGE_BY_COUNTRY.get(country_code)
        if language and language not in candidates:
            candidates.append(language)
    return candidates


def detect_language_candidates(*values: Any) -> list[str]:
    candidates: list[str] = []
    for text in _flatten_text(values):
        for language in _flag_language_candidates(text):
            if language not in candidates:
                candidates.append(language)

        normalized = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
        tokenized = f" {normalized} "
        for canonical, aliases in _LANGUAGE_ALIASES:
            for alias in aliases:
                if re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", tokenized):
                    if canonical not in candidates:
                        candidates.append(canonical)
                    break
    return candidates


def best_language_match(*values: Any) -> str:
    candidates = detect_language_candidates(*values)
    return candidates[0] if candidates else ""
