"""Shared pytest fixtures for the open-web-catcher test suite.

This conftest is intentionally lightweight: it only registers the in-memory
SQLite scaffolding, a settings override helper, and a controllable clock that
later test batches build on. No network services, database servers, or browser
runtimes are started here.

Note on ``fake_clock``: the patch replaces ``datetime.datetime`` with a
subclass, so code reached via ``import datetime; datetime.datetime.utcnow()``
sees the fake time. Modules that executed ``from datetime import datetime`` at
import time keep a direct reference to the original class and need an explicit
``monkeypatch.setattr(<module>, "datetime", ...)`` to observe the fake clock.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Callable, Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.storage.models import Base
from src.utils.config import Settings


@pytest.hookimpl(wrapper=True)
def pytest_cmdline_main(config: pytest.Config):
    """Treat ``-m <expr>`` runs matching zero tests as success (exit 0).

    Until later batches tag tests with ``unit``/``integration``/``replay``/
    ``slow``, ``pytest -m unit`` legitimately selects nothing. Pytest would
    exit 5 (NO_TESTS_COLLECTED); we downgrade that to 0 only when a marker
    expression was given, so a genuinely empty/broken collection without
    ``-m`` still fails loudly.
    """
    exit_code = yield
    if (
        exit_code == pytest.ExitCode.NO_TESTS_COLLECTED
        and config.getoption("markexpr")
    ):
        return pytest.ExitCode.OK
    return exit_code


class FakeClock:
    """Controllable stand-in for ``datetime.utcnow()``.

    ``set()`` jumps to an absolute moment, ``advance()`` moves relative to the
    current fake moment, and calling the instance returns the current moment.
    """

    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2026, 1, 1, 12, 0, 0)

    def __call__(self) -> datetime:
        return self._now

    def set(self, value: datetime) -> datetime:
        self._now = value
        return self._now

    def advance(self, **delta: Any) -> datetime:
        self._now = self._now + timedelta(**delta)
        return self._now


@pytest.fixture()
def session_factory() -> Iterator[sessionmaker]:
    """In-memory SQLite engine + sessionmaker safe for cross-thread access."""
    engine: Engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture()
def db_session(session_factory: sessionmaker) -> Iterator[Any]:
    """Function-scoped session over a schema created fresh and dropped after."""
    bind = session_factory.kw["bind"]
    Base.metadata.create_all(bind=bind)
    session = session_factory()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=bind)


@pytest.fixture()
def settings_override(
    monkeypatch: pytest.MonkeyPatch,
) -> Callable[[dict[str, Any]], Settings]:
    """Return a helper merging ``overrides`` into a live ``Settings`` instance.

    Each key is applied via ``monkeypatch.setattr`` so every override is
    reverted automatically at test teardown. The merged instance is returned so
    tests can hand it directly to the code under test.
    """

    def _apply(overrides: dict[str, Any]) -> Settings:
        settings = Settings()
        for field, value in overrides.items():
            monkeypatch.setattr(settings, field, value)
        return settings

    return _apply


@pytest.fixture()
def fake_clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeClock]:
    """Patch ``datetime.datetime.utcnow`` behind a controllable ``FakeClock``."""
    clock = FakeClock()

    class _FakeDateTime(datetime):
        @classmethod
        def utcnow(cls) -> datetime:
            return clock()

        @classmethod
        def now(cls, tz=None) -> datetime:  # type: ignore[override]
            # Plan T33: writers use aware ``datetime.now(timezone.utc)``.
            moment = clock()
            if tz is not None:
                return moment.replace(tzinfo=tz)
            return moment

    monkeypatch.setattr("datetime.datetime", _FakeDateTime)
    yield clock
