"""Pydantic request/response models for the Vestige HTTP bridge."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ── Search ────────────────────────────────────────────────────────────────────

class SearchMode(str, Enum):
    keyword = "keyword"
    semantic = "semantic"
    hybrid = "hybrid"


class SearchRequest(BaseModel):
    query: str = Field(..., description="Search query text")
    mode: SearchMode = Field(SearchMode.hybrid, description="Search mode")
    limit: int = Field(10, ge=1, le=100, description="Max results")
    threshold: float | None = Field(None, ge=0.0, le=1.0, description="Min relevance score")


# ── Ingest ────────────────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    content: str = Field(..., description="Content to ingest")
    node_type: str = Field("fact", description="Memory node type (fact, concept, event, etc.)")
    tags: list[str] = Field(default_factory=list, description="Tags for organization")
    context: str | None = Field(None, description="Optional context")


class SmartIngestRequest(BaseModel):
    content: str = Field(..., description="Content to ingest")
    node_type: str = Field("fact", description="Memory node type")
    tags: list[str] = Field(default_factory=list, description="Tags")
    context: str | None = Field(None, description="Optional context")


# ── Memory operations ─────────────────────────────────────────────────────────

class MemoryAction(str, Enum):
    get = "get"
    delete = "delete"
    check_state = "check_state"


class MemoryRequest(BaseModel):
    action: MemoryAction = Field(..., description="Action to perform")
    memory_id: str = Field(..., description="Memory ID")


class PromoteRequest(BaseModel):
    memory_id: str = Field(..., description="Memory ID to promote")


class DemoteRequest(BaseModel):
    memory_id: str = Field(..., description="Memory ID to demote")


# ── Codebase ──────────────────────────────────────────────────────────────────

class CodebaseRequest(BaseModel):
    content: str = Field(..., description="Codebase pattern or decision to remember")
    pattern_type: str = Field("pattern", description="Type: pattern, decision, convention")
    tags: list[str] = Field(default_factory=list, description="Tags")
    context: str | None = Field(None, description="Optional context")


# ── Intention ─────────────────────────────────────────────────────────────────

class IntentionRequest(BaseModel):
    content: str = Field(..., description="Intention or reminder content")
    trigger: str | None = Field(None, description="When to trigger")
    tags: list[str] = Field(default_factory=list, description="Tags")


# ── Responses ─────────────────────────────────────────────────────────────────

class VestigeResponse(BaseModel):
    success: bool
    data: Any = None
    error: str | None = None


class HealthResponse(BaseModel):
    status: str  # "healthy" | "degraded" | "unhealthy"
    vestige_connected: bool
    uptime_seconds: float
