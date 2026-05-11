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
    truncate_body_chars: int | None = Field(
        8000,
        ge=0,
        description=(
            "Truncate large body/content/text fields in search results to this many chars. "
            "Set to 0 or null to disable truncation. Default 8000."
        ),
    )


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
    promote = "promote"
    demote = "demote"


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


# ── Dream (v2.0) ─────────────────────────────────────────────────────────────

class DreamRequest(BaseModel):
    memory_count: int = Field(50, ge=1, le=500, description="Number of recent memories to dream about")


# ── Session Context (v2.0) ───────────────────────────────────────────────────

class SessionContextContext(BaseModel):
    codebase: str | None = Field(None, description="Current codebase name")
    topics: list[str] = Field(default_factory=list, description="Current topics")
    file: str | None = Field(None, description="Current file path")


class SessionContextRequest(BaseModel):
    queries: list[str] = Field(default_factory=lambda: ["user preferences"], description="Search queries to run")
    token_budget: int = Field(1000, ge=100, le=10000, description="Max tokens for response")
    context: SessionContextContext | None = Field(None, description="Current context for intention matching")
    include_status: bool = Field(True, description="Include system health info")
    include_intentions: bool = Field(True, description="Include triggered intentions")
    include_predictions: bool = Field(True, description="Include memory predictions")


# ── Explore Connections (v2.0) ───────────────────────────────────────────────

class ExploreAction(str, Enum):
    chain = "chain"
    associations = "associations"
    bridges = "bridges"


class ExploreConnectionsRequest(BaseModel):
    action: ExploreAction = Field(..., description="Type of exploration")
    from_id: str = Field(..., alias="from", description="Source memory ID")
    to_id: str | None = Field(None, alias="to", description="Target memory ID (required for chain/bridges)")
    limit: int = Field(10, ge=1, le=100, description="Maximum results")

    model_config = {"populate_by_name": True}


# ── Predict (v2.0) ──────────────────────────────────────────────────────────

class PredictContext(BaseModel):
    current_file: str | None = Field(None, description="Current file path")
    current_topics: list[str] = Field(default_factory=list, description="Current topics")
    codebase: str | None = Field(None, description="Current codebase")


class PredictRequest(BaseModel):
    context: PredictContext | None = Field(None, description="Current context for prediction")


# ── Importance Score (v2.0) ──────────────────────────────────────────────────

class ImportanceScoreRequest(BaseModel):
    content: str = Field(..., description="Content to score for importance")
    context_topics: list[str] = Field(default_factory=list, description="Topics for novelty detection")
    project: str | None = Field(None, description="Project/codebase name for context")


# ── Consolidate (v2.0) ──────────────────────────────────────────────────────

class ConsolidateRequest(BaseModel):
    """No parameters — runs a full FSRS-6 consolidation cycle."""
    pass


class BackupRequest(BaseModel):
    """No parameters — triggers a SQLite backup of the Vestige database."""
    pass


# ── Responses ─────────────────────────────────────────────────────────────────

class VestigeResponse(BaseModel):
    success: bool
    data: Any = None
    error: str | None = None


class HealthResponse(BaseModel):
    status: str  # "healthy" | "degraded" | "unhealthy"
    vestige_connected: bool
    uptime_seconds: float
