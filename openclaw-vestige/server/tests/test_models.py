"""Basic sanity tests for Pydantic models."""

from app.models import (
    CodebaseAction,
    CodebaseRequest,
    DemoteRequest,
    HealthResponse,
    IngestRequest,
    IntentionAction,
    IntentionRequest,
    IntentionTrigger,
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


def test_promote_demote():
    p = PromoteRequest(memory_id="id1")
    d = DemoteRequest(memory_id="id2")
    assert p.memory_id == "id1"
    assert d.memory_id == "id2"


def test_codebase_request():
    """Mirrors the engine's action-dispatched codebase tool (openclaw-vestige-7wh)."""
    r = CodebaseRequest(
        action=CodebaseAction.remember_decision,
        decision="Use dependency injection",
        rationale="testability",
    )
    assert r.action == CodebaseAction.remember_decision
    assert r.rationale == "testability"


def test_intention_request():
    """`trigger` is an object and `action` is required (openclaw-vestige-7wh)."""
    r = IntentionRequest(
        action=IntentionAction.set,
        description="remind me to review",
        trigger=IntentionTrigger(type="time", in_minutes=30),
    )
    assert r.action == IntentionAction.set
    assert r.trigger is not None
    assert r.trigger.in_minutes == 30


def test_vestige_response():
    r = VestigeResponse(success=True, data={"content": [{"type": "text", "text": "ok"}]})
    assert r.success is True


def test_health_response():
    r = HealthResponse(status="healthy", vestige_connected=True, uptime_seconds=42.5)
    assert r.status == "healthy"
