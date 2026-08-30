"""Blob overflow store (plan task 32).

Oversized inline payloads (``result_full`` / ``content_full``) and inline
base64 screenshot data URIs are written to ``data/blobs/`` as content-addressed
files and replaced in the database with a compact ``blobref:<hash>`` pointer.

- ``write_blob(data)`` -> ``blobref:<sha256[:16]>`` (file ``<sha256[:16]>.blob``)
- ``read_blob(ref)`` -> original bytes (or ``None`` if the file went missing)
- ``cap_or_overflow(value)`` -> the value unchanged when under the cap,
  otherwise a blob ref
- ``data_uri_to_blob_ref(uri)`` -> decode an inline base64 screenshot into a
  file-backed ref

The directory defaults to ``data/blobs`` relative to the working directory and
can be redirected with the ``BLOB_STORE_DIR`` environment variable (used by
tests). Settings resolution is lazy and defensive so persistence never crashes
because settings could not be constructed.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

BLOB_REF_PREFIX = "blobref:"
DEFAULT_CAP_BYTES = 8192
_DATA_URI_RE = re.compile(r"^data:[^;,]+;base64,(?P<payload>.+)$", re.DOTALL)


def blob_dir() -> Path:
    """Resolve the blob storage directory (env override wins)."""
    return Path(os.environ.get("BLOB_STORE_DIR", "data/blobs"))


def is_blob_ref(value: object) -> bool:
    """True when ``value`` already looks like a ``blobref:`` pointer."""
    return str(value or "").startswith(BLOB_REF_PREFIX)


def write_blob(data: bytes | str) -> str:
    """Persist ``data`` under ``data/blobs/<sha256[:16]>.blob``; return its ref."""
    raw = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    digest = hashlib.sha256(raw).hexdigest()
    directory = blob_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{digest[:16]}.blob"
    if not path.exists():
        path.write_bytes(raw)
    return f"{BLOB_REF_PREFIX}{digest[:16]}"


def read_blob(ref: str) -> bytes | None:
    """Read back bytes for a ``blobref:`` pointer; ``None`` when unavailable."""
    text = str(ref or "")
    if not text.startswith(BLOB_REF_PREFIX):
        return None
    key = "".join(ch for ch in text[len(BLOB_REF_PREFIX):].strip() if ch.isalnum())[:16]
    try:
        return (blob_dir() / f"{key}.blob").read_bytes()
    except OSError:
        logger.warning("blob file missing on disk for %s", text[:32])
        return None


def resolve_cap_bytes(cap_bytes: int | None = None) -> int:
    """Explicit override > Settings.payload_cap_bytes > DEFAULT_CAP_BYTES."""
    if cap_bytes is not None and int(cap_bytes) > 0:
        return int(cap_bytes)
    try:
        from src.utils.config import Settings

        configured = int(Settings().payload_cap_bytes)
        return configured if configured > 0 else DEFAULT_CAP_BYTES
    except Exception:  # pragma: no cover - defensive; never break persistence
        return DEFAULT_CAP_BYTES


def cap_or_overflow(field_value: object, *, cap_bytes: int | None = None) -> str:
    """Return ``field_value`` unchanged when it fits the cap, else a blob ref.

    Strings at or under ``cap_bytes`` pass through untouched. Larger strings
    are written to the blob store and replaced by a ``blobref:<hash>``
    pointer whose file round-trips via :func:`read_blob`.
    """
    text = field_value if isinstance(field_value, str) else str(field_value or "")
    if not text or is_blob_ref(text):
        return text
    if len(text.encode("utf-8")) <= resolve_cap_bytes(cap_bytes):
        return text
    return write_blob(text)


def data_uri_to_blob_ref(value: object) -> str:
    """Convert an inline ``data:image/...;base64,...`` URI to a blob ref.

    Non-data-URI inputs (http(s) URLs, existing refs, garbage) come back
    unchanged; undecodable payloads fall back to the original text with a
    warning rather than dropping the screenshot.
    """
    text = str(value or "").strip()
    match = _DATA_URI_RE.match(text)
    if not match:
        return text
    payload = match.group("payload").strip()
    try:
        decoded = base64.b64decode(payload + "=" * (-len(payload) % 4))
    except (binascii.Error, ValueError):
        logger.warning("could not decode inline screenshot data URI; storing as-is")
        return text
    return write_blob(decoded)
