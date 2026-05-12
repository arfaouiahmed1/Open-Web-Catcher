"""Lazy exports for evaluation helpers.

The API imports a small subset of evaluation modules. Keep package import
lightweight so optional benchmark tooling does not load on every startup.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = [
    "CSV_COLUMNS",
    "MetricsCollector",
    "TARGET_TO_CASE_FILE",
    "TOOL_BENCHMARKS",
    "assertions_dataframe",
    "build_dataset_examples",
    "export_dataset_examples",
    "get_all_benchmark_cases",
    "load_case_rows",
    "load_test_cases",
    "pipeline_result_to_dataset_example",
    "results_dataframe",
    "row_to_evaluation_case",
    "run_case_batch",
    "save_results_csv",
    "setup_tracing_from_settings",
    "summarize_results",
    "template_dataframe",
]


def __getattr__(name: str) -> Any:
    module_map = {
        "build_dataset_examples": "src.evaluation.datasets",
        "export_dataset_examples": "src.evaluation.datasets",
        "load_test_cases": "src.evaluation.datasets",
        "pipeline_result_to_dataset_example": "src.evaluation.datasets",
        "MetricsCollector": "src.evaluation.metrics",
        "CSV_COLUMNS": "src.evaluation.notebook_lab",
        "TARGET_TO_CASE_FILE": "src.evaluation.notebook_lab",
        "assertions_dataframe": "src.evaluation.notebook_lab",
        "load_case_rows": "src.evaluation.notebook_lab",
        "results_dataframe": "src.evaluation.notebook_lab",
        "row_to_evaluation_case": "src.evaluation.notebook_lab",
        "run_case_batch": "src.evaluation.notebook_lab",
        "save_results_csv": "src.evaluation.notebook_lab",
        "summarize_results": "src.evaluation.notebook_lab",
        "template_dataframe": "src.evaluation.notebook_lab",
        "TOOL_BENCHMARKS": "src.evaluation.tool_benchmarks",
        "get_all_benchmark_cases": "src.evaluation.tool_benchmarks",
        "setup_tracing_from_settings": "src.evaluation.tracing",
    }
    module_name = module_map.get(name)
    if module_name is None:
        raise AttributeError(f"module 'src.evaluation' has no attribute {name!r}")
    return getattr(import_module(module_name), name)
