"""Containment tests for dataset export path handling.

Every export must land under the server-controlled ``data/exports/<utc-timestamp>/``
root. Traversal strings, absolute paths, drive letters, URL-encoded sequences,
and hostile dataset names must never steer the destination.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from src.storage.dataset_examples import DatasetExample, export_dataset_examples
from src.utils.config import Settings


class _FrozenDateTime(datetime):
    """Deterministic clock for code that imported ``datetime`` directly."""

    @classmethod
    def utcnow(cls) -> datetime:
        return datetime(2026, 8, 22, 12, 0, 0)

    @classmethod
    def now(cls, tz=None) -> datetime:  # type: ignore[override]
        # Plan T33: production stamps come from aware datetime.now(UTC).
        moment = datetime(2026, 8, 22, 12, 0, 0)
        if tz is not None:
            return moment.replace(tzinfo=tz)
        return moment


@pytest.fixture()
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> datetime:
    """Pin ``datetime.utcnow`` inside ``src.storage.dataset_examples``."""
    frozen = _FrozenDateTime.utcnow()
    monkeypatch.setattr("src.storage.dataset_examples.datetime", _FrozenDateTime)
    return frozen


@pytest.fixture()
def settings() -> Settings:
    return Settings()


def _example(tag: str) -> DatasetExample:
    return DatasetExample(
        input={"url": f"https://example.test/{tag}"},
        output={"note": tag},
    )


FROZEN_TIMESTAMP = "20260822-120000"
EXPORTS_ROOT_PARTS = ("data", "exports", FROZEN_TIMESTAMP)

MALICIOUS_PATH_INPUTS = [
    "../../evil.txt",
    "..\\..\\evil.txt",
    "C:\\Windows\\evil.txt",
    "/etc/passwd",
    "%2e%2e%2f%2e%2e/evil.txt",  # URL-encoded traversal, kept in case a layer decodes
]


def _assert_contained(result: str | Path) -> Path:
    """Assert the export destination is inside ``data/exports/<timestamp>/``."""
    result_path = Path(result)
    assert not result_path.is_absolute(), f"export escaped to absolute path: {result_path}"
    assert (
        result_path.parts[:3] == EXPORTS_ROOT_PARTS
    ), f"export not under server-controlled root: {result_path}"
    return result_path


@pytest.mark.parametrize("malicious", MALICIOUS_PATH_INPUTS)
def test_traversal_path_inputs_are_contained(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    frozen_clock: datetime,
    malicious: str,
) -> None:
    """Path-like inputs must never steer the export destination."""
    monkeypatch.chdir(tmp_path)

    result = export_dataset_examples(
        [_example("probe")],
        settings=settings,
        dataset_name="containment-probe",
        path=malicious,
    )

    contained = _assert_contained(result)
    assert contained.exists()
    assert contained.read_text(encoding="utf-8").strip()
    assert not (tmp_path / "evil.txt").exists()
    assert not (tmp_path.parent / "evil.txt").exists()


def test_traversal_dataset_name_is_contained(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    frozen_clock: datetime,
) -> None:
    """A hostile ``dataset_name`` must not escape via the derived filename."""
    monkeypatch.chdir(tmp_path)

    result = export_dataset_examples(
        [_example("probe")],
        settings=settings,
        dataset_name="../../evil",
    )

    contained = _assert_contained(result)
    assert contained.exists()
    assert not (tmp_path.parent / f"evil-{FROZEN_TIMESTAMP}.jsonl").exists()


def test_explicit_path_argument_is_ignored_and_contained(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    frozen_clock: datetime,
) -> None:
    """NEW contract: even an explicit ``path`` argument cannot steer the write.

    The destination is always derived server-side under
    ``data/exports/<utc-timestamp>/``; caller-supplied locations are ignored.
    """
    monkeypatch.chdir(tmp_path)
    requested = tmp_path / "caller-chosen" / "out.jsonl"

    result = export_dataset_examples(
        [_example("a"), _example("b")],
        settings=settings,
        dataset_name="baseline",
        path=str(requested),
    )

    contained = _assert_contained(result)
    assert contained.exists()
    assert not requested.exists()
    assert not requested.parent.exists()
    rows = [json.loads(line) for line in contained.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 2
    assert rows[0]["input"]["url"] == "https://example.test/a"
    assert rows[1]["output"]["note"] == "b"


def test_default_export_lands_in_exports_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    frozen_clock: datetime,
) -> None:
    """No-argument exports land in ``data/exports/<timestamp>/`` with a safe slug."""
    monkeypatch.chdir(tmp_path)

    result = export_dataset_examples(
        [_example("c")],
        settings=settings,
        dataset_name="team runs 2026",  # spaces -> slugified
    )

    contained = _assert_contained(result)
    assert contained.name == f"team_runs_2026-{FROZEN_TIMESTAMP}.jsonl"
    rows = [json.loads(line) for line in contained.read_text(encoding="utf-8").splitlines()]
    assert rows[0]["input"]["url"] == "https://example.test/c"
