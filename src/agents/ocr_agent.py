"""OCR agent — channel/logo detection over screenshots (plan T16, evidence U17).

Skeleton for the future visual-RAG index: channel candidates come from OCR-text
token matching against ``datasets/channels_seed.json`` merged with a pluggable
``ChannelEmbeddingIndex``. The default index is a no-op stub; the pgvector-backed
logo index (``logo_embeddings`` table) lands in batch W4 (task 18) and only has
to satisfy the protocol defined here.

Optional dependency: ``pip install -e ".[ocr]"`` installs pytesseract + Pillow.
Without them the agent degrades gracefully — empty ``ocr_text``, embedding
vector ``[]`` — and never raises into the pipeline.
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

import httpx

from src.models.schemas import OcrResult
from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)

CHANNELS_SEED_PATH = Path("datasets/channels_seed.json")

_TOKEN_RE = re.compile(r"[a-z0-9+]+")
_EMBEDDING_GRID = (8, 8)


@runtime_checkable
class ChannelEmbeddingIndex(Protocol):
    """Lookup seam for the W4 pgvector logo-embedding index.

    Implementations return ``(channel_label, similarity)`` pairs with
    similarity in [0, 1]. The image embedding is a placeholder until the real
    encoder ships in W4; implementations must tolerate ``[]``.
    """

    def find_matches(self, image_embedding: list[float]) -> list[tuple[str, float]]: ...


class StubEmbeddingIndex:
    """No-op index: returns no matches until W4 replaces it."""

    def find_matches(self, image_embedding: list[float]) -> list[tuple[str, float]]:
        _ = image_embedding
        return []


def load_channel_seed(path: Path | str | None = None) -> list[dict[str, Any]]:
    seed_path = Path(path) if path is not None else CHANNELS_SEED_PATH
    try:
        payload = json.loads(seed_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Channel seed %s unreadable: %s", seed_path, exc)
        return []
    channels = payload.get("channels", []) if isinstance(payload, dict) else []
    return [entry for entry in channels if isinstance(entry, dict)]


async def _load_image_bytes(screenshot_ref: str) -> bytes | None:
    ref = (screenshot_ref or "").strip()
    if not ref:
        return None
    if ref.lower().startswith(("http://", "https://")):
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                response = await client.get(ref)
                response.raise_for_status()
                return response.content
        except (httpx.HTTPError, OSError) as exc:
            logger.warning("OCR agent could not download %s: %s", ref, exc)
            return None
    try:
        return Path(ref).read_bytes()
    except OSError as exc:
        logger.warning("OCR agent could not read %s: %s", ref, exc)
        return None


def _ocr_text(image_bytes: bytes) -> str:
    try:
        import pytesseract
        from PIL import Image
    except ImportError:
        return ""
    try:
        image = Image.open(io.BytesIO(image_bytes))
        return str(pytesseract.image_to_string(image) or "")
    except Exception:  # noqa: BLE001 — corrupt images / missing tesseract binary degrade to ""
        logger.debug("OCR text extraction failed", exc_info=True)
        return ""


def compute_image_embedding(image_bytes: bytes) -> list[float]:
    """Placeholder encoder (8x8 grayscale grid); replaced by the W4 CLIP-style encoder."""
    try:
        from PIL import Image
    except ImportError:
        return []
    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("L").resize(_EMBEDDING_GRID)
        return [channel / 255.0 for channel in image.tobytes()]
    except Exception:  # noqa: BLE001
        logger.debug("Image embedding computation failed", exc_info=True)
        return []


def match_seed_channels(ocr_text: str, seed: list[dict[str, Any]]) -> dict[str, float]:
    text = ocr_text.lower()
    tokens = set(_TOKEN_RE.findall(text))
    scores: dict[str, float] = {}
    for entry in seed:
        label = str(entry.get("name", "")).strip()
        if not label:
            continue
        variants = [label, *(str(alias) for alias in entry.get("aliases", []) if str(alias).strip())]
        best = 0.0
        for variant in variants:
            normalized = variant.lower()
            variant_tokens = _TOKEN_RE.findall(normalized)
            if not variant_tokens:
                continue
            if normalized in text:
                best = max(best, 0.75)
            elif set(variant_tokens).issubset(tokens):
                best = max(best, 0.65)
        if best > 0.0:
            scores[label] = max(scores.get(label, 0.0), best)
    return scores


def merge_candidates(
    seed_scores: dict[str, float],
    embedding_matches: list[tuple[str, float]],
) -> list[tuple[str, float]]:
    """Noisy-or merge: agreeing evidence boosts confidence; disagreement keeps the max."""
    merged: dict[str, float] = {label: max(0.0, min(1.0, score)) for label, score in seed_scores.items()}
    for label, raw_score in embedding_matches:
        score = max(0.0, min(1.0, float(raw_score)))
        prior = merged.get(label, 0.0)
        merged[label] = round(1.0 - (1.0 - prior) * (1.0 - score), 4)
    return sorted(merged.items(), key=lambda item: (-item[1], item[0]))


class OcrAgent:
    def __init__(
        self,
        settings: Settings,
        *,
        embedding_index: ChannelEmbeddingIndex | None = None,
        seed_path: Path | str | None = None,
    ) -> None:
        self.settings = settings
        self.embedding_index: ChannelEmbeddingIndex = embedding_index or StubEmbeddingIndex()
        self.seed_path = Path(seed_path) if seed_path is not None else CHANNELS_SEED_PATH

    async def run(self, screenshot_ref: str, observer: Any | None = None) -> OcrResult:
        result = OcrResult(source_screenshot_url=screenshot_ref or "")
        if observer is not None:
            observer.emit("agent_started", f"OCR agent started for {screenshot_ref}")
        if not self.settings.ocr_enabled:
            if observer is not None:
                observer.emit(
                    "agent_finished",
                    "OCR enrichment disabled by settings",
                    status="skipped",
                    details={"source": screenshot_ref},
                )
            return result

        image_bytes = await _load_image_bytes(screenshot_ref)
        if image_bytes is None:
            if observer is not None:
                observer.emit(
                    "agent_finished",
                    "OCR agent could not load screenshot",
                    status="failed",
                    details={"source": screenshot_ref},
                )
            return result

        result.ocr_text = _ocr_text(image_bytes)
        seed = load_channel_seed(self.seed_path)
        seed_scores = match_seed_channels(result.ocr_text, seed)
        try:
            embedding_matches = self.embedding_index.find_matches(compute_image_embedding(image_bytes))
        except Exception as exc:  # noqa: BLE001 — index failures must not kill enrichment
            logger.warning("Embedding index failed for %s: %s", screenshot_ref, exc)
            embedding_matches = []

        threshold = float(self.settings.ocr_min_confidence)
        ranked = [
            (label, score)
            for label, score in merge_candidates(seed_scores, embedding_matches)
            if score >= threshold
        ]
        result.candidates = [label for label, _score in ranked]
        if ranked:
            result.channel_label, result.confidence = ranked[0]

        if observer is not None:
            observer.emit(
                "agent_finished",
                f"OCR detected {result.channel_label or 'no channel'}",
                status="success",
                details={
                    "candidates": result.candidates,
                    "confidence": result.confidence,
                    "ocr_text_chars": len(result.ocr_text),
                },
            )
        return result
