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
    mode: SearchMode = Field(
        SearchMode.hybrid,
        description=(
            "Deprecated — accepted for backward compatibility but not forwarded. "
            "The engine's unified `search` tool is always hybrid (keyword + semantic)."
        ),
    )
    limit: int = Field(10, ge=1, le=100, description="Max results")
    threshold: float | None = Field(
        None,
        ge=0.0,
        le=1.0,
        description="Min similarity score — forwarded as the engine's `min_similarity`",
    )
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
    state = "state"
    check_state = "check_state"  # deprecated REST alias for "state"
    promote = "promote"
    demote = "demote"
    edit = "edit"


#: REST action values that are not engine action values. The engine's `memory`
#: tool enum is ["get", "delete", "state", "promote", "demote", "edit"]; the
#: bridge historically exposed "check_state", which the engine rejects.
MEMORY_ACTION_ALIASES: dict[str, str] = {"check_state": "state"}


class MemoryRequest(BaseModel):
    action: MemoryAction = Field(..., description="Action to perform")
    memory_id: str = Field(..., description="Memory ID — forwarded as the engine's `id`")
    reason: str | None = Field(
        None, description="Why this memory is promoted/demoted (promote/demote only)"
    )
    content: str | None = Field(None, description="Replacement content (edit only)")


class PromoteRequest(BaseModel):
    memory_id: str = Field(..., description="Memory ID to promote")


class DemoteRequest(BaseModel):
    memory_id: str = Field(..., description="Memory ID to demote")


# ── Codebase ──────────────────────────────────────────────────────────────────

class CodebaseAction(str, Enum):
    remember_pattern = "remember_pattern"
    remember_decision = "remember_decision"
    get_context = "get_context"


class CodebaseRequest(BaseModel):
    """Mirrors the engine's `codebase` tool schema field-for-field."""

    action: CodebaseAction = Field(..., description="Action to perform")
    # remember_pattern
    name: str | None = Field(None, description="Pattern name (remember_pattern)")
    description: str | None = Field(None, description="Pattern description (remember_pattern)")
    # remember_decision
    decision: str | None = Field(None, description="The decision made (remember_decision)")
    rationale: str | None = Field(None, description="Why (remember_decision)")
    alternatives: list[str] = Field(default_factory=list, description="Alternatives considered")
    # shared
    files: list[str] = Field(default_factory=list, description="Files involved")
    codebase: str | None = Field(None, description="Codebase/project identifier")
    # get_context
    limit: int = Field(10, ge=1, le=100, description="Max items per category (get_context)")


# ── Intention ─────────────────────────────────────────────────────────────────

class IntentionAction(str, Enum):
    set = "set"
    check = "check"
    update = "update"
    list = "list"


class IntentionPriority(str, Enum):
    low = "low"
    normal = "normal"
    high = "high"
    critical = "critical"


class IntentionStatus(str, Enum):
    complete = "complete"
    snooze = "snooze"
    cancel = "cancel"


class IntentionFilterStatus(str, Enum):
    active = "active"
    fulfilled = "fulfilled"
    cancelled = "cancelled"
    snoozed = "snoozed"
    all = "all"


class IntentionTriggerType(str, Enum):
    time = "time"
    context = "context"
    event = "event"


class IntentionTrigger(BaseModel):
    type: IntentionTriggerType | None = Field(None, description="Trigger type")
    at: str | None = Field(None, description="ISO timestamp for time triggers")
    in_minutes: int | None = Field(None, description="Minutes from now")
    codebase: str | None = Field(None, description="Trigger when in this codebase")
    file_pattern: str | None = Field(None, description="Trigger on files matching this pattern")
    topic: str | None = Field(None, description="Trigger when discussing this topic")
    condition: str | None = Field(None, description="Natural-language condition for event triggers")


class IntentionContext(BaseModel):
    current_time: str | None = Field(None, description="Current ISO timestamp")
    codebase: str | None = Field(None, description="Current codebase")
    file: str | None = Field(None, description="Current file path")
    topics: list[str] = Field(default_factory=list, description="Current discussion topics")


class IntentionRequest(BaseModel):
    """Mirrors the engine's `intention` tool schema field-for-field."""

    action: IntentionAction = Field(..., description="Action to perform")
    # set
    description: str | None = Field(None, description="What to remember to do (set)")
    trigger: IntentionTrigger | None = Field(None, description="When to trigger (set)")
    priority: IntentionPriority | None = Field(None, description="Priority level (set)")
    deadline: str | None = Field(None, description="Optional ISO deadline (set)")
    # update
    id: str | None = Field(None, description="Intention ID (update)")
    status: IntentionStatus | None = Field(None, description="New status (update)")
    snooze_minutes: int | None = Field(None, description="Minutes to snooze (update)")
    # check
    context: IntentionContext | None = Field(None, description="Current context (check)")
    include_snoozed: bool | None = Field(None, description="Include snoozed intentions (check)")
    # list
    filter_status: IntentionFilterStatus | None = Field(None, description="Status filter (list)")
    limit: int | None = Field(None, ge=1, le=200, description="Max results (list)")


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
