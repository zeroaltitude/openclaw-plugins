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
            "Accepted for backwards compatibility and ignored. The engine's unified "
            "`search` tool has no mode parameter — it always runs hybrid (keyword + "
            "semantic + convex fusion) internally."
        ),
    )
    limit: int = Field(10, ge=1, le=100, description="Max results")
    threshold: float | None = Field(
        None,
        ge=0.0,
        le=1.0,
        description="Min similarity score 0-1 (forwarded as the engine's minSimilarity)",
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
    check_state = "check_state"  # legacy alias for "state"
    promote = "promote"
    demote = "demote"


# The engine's memory tool declares enum ["get", "delete", "state", "promote",
# "demote", "edit"] (crates/vestige-mcp/src/tools/memory_unified.rs). Anything
# this bridge accepts but the engine doesn't must be translated here.
MEMORY_ACTION_TO_ENGINE: dict[MemoryAction, str] = {
    MemoryAction.check_state: "state",
}


class MemoryRequest(BaseModel):
    action: MemoryAction = Field(..., description="Action to perform")
    memory_id: str = Field(..., description="Memory ID")


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
    """Mirrors the engine's unified `codebase` tool.

    See vestige: crates/vestige-mcp/src/tools/codebase_unified.rs. Required
    fields are action-dependent and validated by the engine, not here.
    """

    action: CodebaseAction = Field(..., description="Action to perform")
    # remember_pattern
    name: str | None = Field(None, description="[remember_pattern] Pattern name/title")
    description: str | None = Field(None, description="[remember_pattern] Pattern description")
    # remember_decision
    decision: str | None = Field(None, description="[remember_decision] The decision made")
    rationale: str | None = Field(None, description="[remember_decision] Why it was made")
    alternatives: list[str] = Field(
        default_factory=list, description="[remember_decision] Alternatives considered"
    )
    # shared
    files: list[str] = Field(default_factory=list, description="Files affected")
    codebase: str | None = Field(None, description="Codebase/project identifier")
    # get_context
    limit: int | None = Field(None, ge=1, le=100, description="[get_context] Max items per category")


# ── Intention ─────────────────────────────────────────────────────────────────

class IntentionAction(str, Enum):
    set = "set"
    check = "check"
    update = "update"
    list = "list"


class IntentionTrigger(BaseModel):
    """[set] When to fire. Mirrors the engine's TriggerSpec."""

    type: str | None = Field(None, description="time | context | event")
    at: str | None = Field(None, description="ISO timestamp for time triggers")
    in_minutes: int | None = Field(None, description="Minutes from now")
    codebase: str | None = Field(None, description="Trigger while in this codebase")
    file_pattern: str | None = Field(None, description="Trigger on files matching this pattern")
    topic: str | None = Field(None, description="Trigger when discussing this topic")
    condition: str | None = Field(None, description="Natural-language condition for event triggers")


#: The engine's TriggerSpec is #[serde(rename_all = "camelCase")] with no serde
#: aliases, so its multi-word fields only deserialize from camelCase even though
#: the advertised JSON schema spells them snake_case. Translate on the way out.
TRIGGER_FIELD_TO_ENGINE: dict[str, str] = {
    "in_minutes": "inMinutes",
    "file_pattern": "filePattern",
}


class IntentionContext(BaseModel):
    """[check] Current context for matching intentions."""

    codebase: str | None = Field(None, description="Current codebase/project name")
    file: str | None = Field(None, description="Current file path")
    topics: list[str] = Field(default_factory=list, description="Current discussion topics")


class IntentionRequest(BaseModel):
    """Mirrors the engine's unified `intention` tool.

    See vestige: crates/vestige-mcp/src/tools/intention_unified.rs. Required
    fields are action-dependent and validated by the engine, not here.
    """

    action: IntentionAction = Field(..., description="set | check | update | list")
    # set
    description: str | None = Field(None, description="[set] What to remember to do")
    trigger: IntentionTrigger | None = Field(None, description="[set] When to trigger")
    priority: str | None = Field(None, description="[set] low | normal | high | critical")
    deadline: str | None = Field(None, description="[set] Optional ISO deadline")
    # update
    id: str | None = Field(None, description="[update] Intention ID")
    status: str | None = Field(None, description="[update] complete | snooze | cancel")
    snooze_minutes: int | None = Field(None, description="[update] Minutes to snooze")
    # check
    context: IntentionContext | None = Field(None, description="[check] Current context")
    include_snoozed: bool | None = Field(None, description="[check] Include snoozed intentions")
    # list
    filter_status: str | None = Field(
        None, description="[list] active | fulfilled | cancelled | snoozed | all"
    )
    limit: int | None = Field(None, ge=1, le=100, description="[list] Max intentions to return")


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
