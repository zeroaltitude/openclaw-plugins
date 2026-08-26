"""Basic sanity tests for Pydantic models."""

import pytest
from pydantic import ValidationError

from app.models import (
    CodebaseRequest,
    DemoteRequest,
    HealthResponse,
    IngestRequest,
    IntentionRequest,
    MemoryAction,
    MemoryRequest,
    PromoteRequest,
    SearchMode,
    SearchRequest,
    SmartIngestRequest,
    VestigeResponse,
)


def test_search_request_defaults():
    r = SearchRequest(query="hello")
    assert r.mode == SearchMode.hybrid
    assert r.limit == 10
    assert r.threshold is None


def test_search_request_custom():
    r = SearchRequest(query="q", mode="keyword", limit=5, threshold=0.5)
    assert r.mode == SearchMode.keyword
    assert r.limit == 5


def test_ingest_request():
    r = IngestRequest(content="x", tags=["a", "b"])
    assert r.node_type == "fact"
    assert len(r.tags) == 2


def test_smart_ingest_request():
    r = SmartIngestRequest(content="important thing", node_type="concept")
    assert r.content == "important thing"


def test_memory_request():
    r = MemoryRequest(action=MemoryAction.get, memory_id="abc-123")
    assert r.action == MemoryAction.get


# ── openclaw-vestige-cmj: the `edit` action ──────────────────────────────────

def test_memory_request_edit_carries_content():
    r = MemoryRequest(action=MemoryAction.edit, memory_id="abc-123", content="rewritten")
    assert r.action == MemoryAction.edit
    assert r.content == "rewritten"


@pytest.mark.parametrize(
    "content",
    [None, "", "   ", "\n\t "],
    ids=["missing", "empty", "spaces", "whitespace"],
)
def test_memory_request_edit_without_content_is_rejected(content):
    """The engine fails these too — but only after a round trip. Reject locally."""
    with pytest.raises(ValidationError) as excinfo:
        MemoryRequest(action=MemoryAction.edit, memory_id="abc-123", content=content)
    assert "content" in str(excinfo.value)


@pytest.mark.parametrize(
    "action",
    [
        MemoryAction.get,
        MemoryAction.delete,
        MemoryAction.state,
        MemoryAction.check_state,
        MemoryAction.promote,
        MemoryAction.demote,
    ],
)
def test_memory_request_content_only_required_for_edit(action):
    """The guard must not make `content` mandatory for every action."""
    r = MemoryRequest(action=action, memory_id="abc-123")
    assert r.content is None


def test_promote_demote():
    p = PromoteRequest(memory_id="id1")
    d = DemoteRequest(memory_id="id2")
    assert p.memory_id == "id1"
    assert d.memory_id == "id2"


def test_codebase_request():
    r = CodebaseRequest(
        action="remember_decision",
        decision="Use dependency injection",
        rationale="Testability",
    )
    assert r.action.value == "remember_decision"
    assert r.decision == "Use dependency injection"


def test_intention_request():
    r = IntentionRequest(
        action="set",
        description="remind me to review",
        trigger={"type": "context", "condition": "next session"},
    )
    assert r.action.value == "set"
    assert r.trigger.condition == "next session"


def test_vestige_response():
    r = VestigeResponse(success=True, data={"content": [{"type": "text", "text": "ok"}]})
    assert r.success is True


def test_health_response():
    r = HealthResponse(status="healthy", vestige_connected=True, uptime_seconds=42.5)
    assert r.status == "healthy"
