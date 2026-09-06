"""HTTP request contracts shared by the FastAPI route modules."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ClassifyRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class ExtractRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    page_type: Literal["landing_page", "hosting_page", "embedded_page"]


class RunRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class DatasetExportRequest(BaseModel):
    dataset_name: str = Field(default="", max_length=255)
    limit: int = Field(default=25, ge=1, le=1000)


class PromptUpdateRequest(BaseModel):
    content: str = Field(default="", max_length=200_000)


class MemorySearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4_000)
    domain: str = Field(default="", max_length=120)
    page_type: str = Field(default="", max_length=120)
    limit: int = Field(default=8, ge=1, le=100)


class PromptDryRunRequest(BaseModel):
    agent: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2048)
    content: str = Field(default="", max_length=200_000)


class RunDecisionUpsertRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    summary: str = Field(default="", max_length=20_000)
    actor: str = Field(default="", max_length=120)
    category: str = Field(default="", max_length=120)
    status: str = Field(default="open", max_length=40)
    details: dict[str, Any] = Field(default_factory=dict)


class RunTaskUpsertRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=20_000)
    actor: str = Field(default="", max_length=120)
    priority: str = Field(default="medium", max_length=40)
    status: str = Field(default="open", max_length=40)
    details: dict[str, Any] = Field(default_factory=dict)


class RunAutoDecisionSyncItem(BaseModel):
    auto_key: str = Field(min_length=1, max_length=255)
    title: str = Field(min_length=1, max_length=255)
    summary: str = Field(default="", max_length=20_000)
    actor: str = Field(default="", max_length=120)
    category: str = Field(default="", max_length=120)
    status: str = Field(default="open", max_length=40)
    details: dict[str, Any] = Field(default_factory=dict)


class RunAutoLogsSyncRequest(BaseModel):
    decisions: list[RunAutoDecisionSyncItem] = Field(default_factory=list, max_length=500)


class PricingSyncRequest(BaseModel):
    provider: str = Field(default="", max_length=120)
    max_models: int | None = Field(default=None, ge=1, le=1000)
