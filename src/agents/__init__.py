"""Lazy exports for agent entry points.

Avoid importing every concrete agent at package import time. This keeps
lightweight modules such as the orchestrator importable without eagerly
initializing LLM-specific dependencies.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = [
    "ClassificationAgent",
    "LandingPageAgent",
    "HostingPageAgent",
    "EmbeddedPageAgent",
    "run_pipeline",
]


def __getattr__(name: str) -> Any:
    if name == "ClassificationAgent":
        return getattr(import_module("src.agents.classification"), name)
    if name == "LandingPageAgent":
        return getattr(import_module("src.agents.landing_page"), name)
    if name == "HostingPageAgent":
        return getattr(import_module("src.agents.hosting_page"), name)
    if name == "EmbeddedPageAgent":
        return getattr(import_module("src.agents.embedded_page"), name)
    if name == "run_pipeline":
        return getattr(import_module("src.agents.orchestrator"), name)
    raise AttributeError(f"module 'src.agents' has no attribute {name!r}")
