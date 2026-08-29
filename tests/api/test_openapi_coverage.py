"""OpenAPI coverage gate smoke tests (plan task 13, slice 1).

The >=95% hard gate is intentionally NOT asserted yet: it activates after the
response-annotation waves land. Here we only prove the script is importable,
executes, and reports a real number.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

pytestmark = pytest.mark.unit

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "check_openapi_coverage.py"


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_openapi_coverage", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before exec: dataclass resolution needs sys.modules[cls.__module__].
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_measure_reports_coverage_number_when_app_schema_built():
    module = _load_script()
    rows, pct = module.measure()
    assert isinstance(pct, float)
    assert 0.0 <= pct <= 100.0
    assert rows, "expected a non-empty OpenAPI operation surface"
    for row in rows:
        assert row.method and row.path and row.handler


def test_cli_executes_and_prints_report_when_run_as_script():
    proc = subprocess.run(
        [sys.executable, str(SCRIPT_PATH)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    # 0 (>= threshold) and 1 (< threshold) are both valid pre-gate outcomes.
    assert proc.returncode in (0, 1), proc.stderr
    assert "Coverage:" in proc.stdout
