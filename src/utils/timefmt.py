"""ISO-8601 UTC serialization helpers (plan T33).

Single source of truth for timestamp emission across the API serializer
layer: every wire-format stamp ends in ``Z`` so browsers parse the instant
correctly regardless of their local timezone.
"""

from __future__ import annotations

from datetime import UTC, datetime


def to_utc(value: datetime) -> datetime:
    """Return ``value`` as a timezone-aware UTC datetime.

    Naive values are interpreted AS UTC (the storage convention restored by
    the 20260826_0020 backfill), never as local time.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def iso_z(value: datetime | str | None) -> str:
    """Serialize a datetime as ISO-8601 ending in ``Z``.

    - ``None`` -> ``""`` (matches the previous ``x.isoformat() if x else ""``
      idiom at call sites).
    - naive datetimes are assumed UTC (legacy rows / defensive reads).
    - strings pass through untouched (already-serialized stamps).
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return to_utc(value).isoformat().replace("+00:00", "Z")
