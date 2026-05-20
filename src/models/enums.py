"""Shared enumerations used across the pipeline."""

from enum import StrEnum


class PageType(StrEnum):
    LANDING = "landing_page"
    HOSTING = "hosting_page"
    EMBEDDED = "embedded_page"
    UNKNOWN = "unknown"


class Confidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class ExtractionStatus(StrEnum):
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
    TIMEOUT = "timeout"
    SITE_DEAD = "site_dead"
    REDIRECT = "redirect"
    PAGE_INACCESSIBLE = "page_inaccessible"
    NO_HOSTING_PAGES = "no_hosting_pages"
    NO_STREAMS = "no_streams"


class AgentType(StrEnum):
    CLASSIFICATION = "classification"
    LANDING_PAGE = "landing_page"
    HOSTING_PAGE = "hosting_page"
    EMBEDDED_PAGE = "embedded_page"
    ORCHESTRATOR = "orchestrator"
