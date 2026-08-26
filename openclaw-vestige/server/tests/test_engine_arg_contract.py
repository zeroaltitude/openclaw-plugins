"""Contract test: every argument the bridge sends must be one the engine reads.

The bridge's only job is REST → MCP translation, and its failure mode is silent:
the engine's argument structs do not use ``deny_unknown_fields``, so a misspelled
argument is either dropped without a word (wrong answers) or trips a
missing-required-field error the caller sees as an opaque tool error. Both have
happened — see ``openclaw-vestige-ow6`` (``/memory`` sent ``memory_id``, the tool
requires ``id``) and ``openclaw-vestige-7wh`` (``/codebase`` and ``/intention``
never sent the required ``action``; ``/search``'s ``threshold`` was dropped).

``ENGINE_ARGS`` below is a checked-in snapshot of what each engine tool actually
*deserializes*, taken from the Rust argument structs in
``vestige/crates/vestige-mcp/src/tools/``. It is the struct, not the advertised
JSON schema, that decides — several structs are
``#[serde(rename_all = "camelCase")]`` without aliases, so they only accept
camelCase for multi-word fields even though the published schema spells them
snake_case. Where an ``#[serde(alias = ...)]`` exists, both spellings are listed.

When the engine changes, update this snapshot in the same PR.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Patch the MCP client at import time so lifespan doesn't try to connect.
_mock_mcp = AsyncMock()
_mock_mcp.alive = True
_mock_mcp.uptime = 0.0
_mock_mcp.tool_names = []
_mock_mcp.connect = AsyncMock()
_mock_mcp.disconnect = AsyncMock()
_mock_mcp.health_check = AsyncMock(return_value=True)

AGENT_HEADERS = {"X-Agent-Id": "tank"}
MEMORY_UUID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

#: Argument names no engine struct declares but every one tolerates, because none
#: of them deny unknown fields. Carried for MCP-level attribution/logging.
TOLERATED_EVERYWHERE = {"agent_id"}

#: tool name -> {"accepts": names the struct deserializes,
#:               "requires": names the tool fails without}
ENGINE_ARGS: dict[str, dict[str, set[str]]] = {
    # search_unified.rs — SearchArgs, rename_all = "camelCase";
    # aliases exist only for detail_level and token_budget.
    "search": {
        "accepts": {
            "query",
            "limit",
            "minRetention",
            "minSimilarity",
            "detailLevel",
            "detail_level",
            "contextTopics",
            "tokenBudget",
            "token_budget",
        },
        "requires": {"query"},
    },
    # smart_ingest.rs — SmartIngestArgs, rename_all = "camelCase",
    # alias node_type. "ingest" is a deprecated alias that dispatches here.
    "smart_ingest": {
        "accepts": {"content", "nodeType", "node_type", "tags", "source", "forceCreate", "items"},
        "requires": {"content"},
    },
    "ingest": {
        "accepts": {"content", "nodeType", "node_type", "tags", "source", "forceCreate", "items"},
        "requires": {"content"},
    },
    # memory_unified.rs — MemoryArgs (all single-word, so rename_all is a no-op).
    "memory": {
        "accepts": {"action", "id", "reason", "content"},
        "requires": {"action", "id"},
    },
    # codebase_unified.rs — CodebaseArgs (all single-word).
    "codebase": {
        "accepts": {
            "action",
            "name",
            "description",
            "decision",
            "rationale",
            "alternatives",
            "files",
            "codebase",
            "limit",
        },
        "requires": {"action"},
    },
    # intention_unified.rs — UnifiedIntentionArgs has NO rename_all (so snake_case
    # works at the top level), but the nested TriggerSpec/ContextSpec DO.
    "intention": {
        "accepts": {
            "action",
            "description",
            "trigger",
            "priority",
            "deadline",
            "id",
            "status",
            "snooze_minutes",
            "snoozeMinutes",
            "context",
            "include_snoozed",
            "includeSnoozed",
            "filter_status",
            "filterStatus",
            "limit",
        },
        "requires": {"action"},
    },
    # dream.rs, session_context.rs, explore.rs, predict.rs — snake_case, either
    # read via raw Value::get or on structs without rename_all.
    "dream": {"accepts": {"memory_count"}, "requires": set()},
    "session_context": {
        "accepts": {
            "queries",
            "token_budget",
            "context",
            "include_status",
            "include_intentions",
            "include_predictions",
        },
        "requires": set(),
    },
    "explore_connections": {
        "accepts": {"action", "from", "to", "limit"},
        "requires": {"action", "from"},
    },
    "predict": {"accepts": {"context"}, "requires": set()},
    # importance.rs — ImportanceArgs, rename_all = "camelCase", no alias.
    "importance_score": {"accepts": {"content", "contextTopics", "project"}, "requires": {"content"}},
    # maintenance.rs — consolidate_schema/backup_schema take no properties.
    "consolidate": {"accepts": set(), "requires": set()},
    "backup": {"accepts": set(), "requires": set()},
}

#: One representative request per endpoint, exercising as many optional fields as
#: possible so the contract check sees every argument the handler can emit.
#: (endpoint, request body, expected tool name)
ENDPOINT_CASES: list[tuple[str, dict, str]] = [
    ("/search", {"query": "q", "mode": "hybrid", "limit": 5, "threshold": 0.4}, "search"),
    ("/ingest", {"content": "c", "node_type": "fact", "tags": ["t"], "context": "ctx"}, "ingest"),
    (
        "/smart_ingest",
        {"content": "c", "node_type": "fact", "tags": ["t"], "context": "ctx"},
        "smart_ingest",
    ),
    ("/promote", {"memory_id": MEMORY_UUID}, "memory"),
    ("/demote", {"memory_id": MEMORY_UUID}, "memory"),
    ("/memory", {"action": "get", "memory_id": MEMORY_UUID}, "memory"),
    (
        "/codebase",
        {
            "action": "remember_pattern",
            "name": "n",
            "description": "d",
            "files": ["a.py"],
            "codebase": "vestige",
        },
        "codebase",
    ),
    (
        "/codebase",
        {
            "action": "remember_decision",
            "decision": "use sqlite",
            "rationale": "single host",
            "alternatives": ["postgres"],
            "codebase": "vestige",
        },
        "codebase",
    ),
    ("/codebase", {"action": "get_context", "codebase": "vestige", "limit": 5}, "codebase"),
    (
        "/intention",
        {
            "action": "set",
            "description": "check the deploy",
            "trigger": {"type": "time", "in_minutes": 30, "file_pattern": "*.py"},
            "priority": "high",
            "deadline": "2026-09-01T00:00:00Z",
        },
        "intention",
    ),
    (
        "/intention",
        {"action": "check", "context": {"codebase": "vestige", "topics": ["memory"]}},
        "intention",
    ),
    (
        "/intention",
        {"action": "update", "id": "abc", "status": "snooze", "snooze_minutes": 15},
        "intention",
    ),
    ("/intention", {"action": "list", "filter_status": "active", "limit": 5}, "intention"),
    ("/dream", {"memory_count": 25}, "dream"),
    (
        "/session_context",
        {"queries": ["q"], "token_budget": 500, "context": {"codebase": "vestige"}},
        "session_context",
    ),
    (
        "/explore_connections",
        {"action": "chain", "from": MEMORY_UUID, "to": MEMORY_UUID, "limit": 3},
        "explore_connections",
    ),
    ("/predict", {"context": {"current_file": "a.py", "current_topics": ["x"]}}, "predict"),
    (
        "/importance_score",
        {"content": "c", "context_topics": ["x"], "project": "vestige"},
        "importance_score",
    ),
    ("/consolidate", {}, "consolidate"),
    ("/backup", {}, "backup"),
]


@pytest.fixture()
def client(monkeypatch):
    """TestClient with a mocked MCP client and no auth."""
    monkeypatch.setenv("VESTIGE_ALLOW_ANONYMOUS", "true")
    monkeypatch.delenv("VESTIGE_AUTH_TOKEN", raising=False)

    with patch("app.main.mcp", _mock_mcp):
        from app.main import app

        with TestClient(app, raise_server_exceptions=True) as c:
            yield c


def _call(client, endpoint: str, body: dict) -> tuple[str, dict]:
    """POST an endpoint with an agent header and return (tool_name, arguments)."""
    _mock_mcp.call_tool = AsyncMock(return_value={"ok": True})
    resp = client.post(endpoint, json=body, headers=AGENT_HEADERS)
    assert resp.status_code == 200, resp.text
    name, args = _mock_mcp.call_tool.await_args.args
    return name, args


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("endpoint", "body", "tool"),
    ENDPOINT_CASES,
    ids=[f"{e}:{b.get('action', '-')}" for e, b, _ in ENDPOINT_CASES],
)
def test_endpoint_sends_only_arguments_the_engine_reads(client, endpoint, body, tool):
    """No endpoint may send an argument name the engine's struct doesn't accept."""
    name, args = _call(client, endpoint, body)
    assert name == tool

    allowed = ENGINE_ARGS[tool]["accepts"] | TOLERATED_EVERYWHERE
    unknown = set(args) - allowed
    assert not unknown, (
        f"{endpoint} sends {sorted(unknown)} to the {tool!r} tool, which does not "
        f"deserialize them. Accepted: {sorted(allowed)}"
    )


@pytest.mark.parametrize(
    ("endpoint", "body", "tool"),
    ENDPOINT_CASES,
    ids=[f"{e}:{b.get('action', '-')}" for e, b, _ in ENDPOINT_CASES],
)
def test_endpoint_sends_every_required_argument(client, endpoint, body, tool):
    """Required arguments must be present or the engine rejects the whole call."""
    _, args = _call(client, endpoint, body)
    missing = ENGINE_ARGS[tool]["requires"] - set(args)
    assert not missing, f"{endpoint} omits required {sorted(missing)} for the {tool!r} tool"


def test_every_endpoint_case_names_a_known_tool():
    """Guard the fixture itself: every case must reference a snapshotted tool."""
    for endpoint, _, tool in ENDPOINT_CASES:
        assert tool in ENGINE_ARGS, f"{endpoint} maps to unsnapshotted tool {tool!r}"


# ---------------------------------------------------------------------------
# Specific drifts this file exists to prevent regressing
# ---------------------------------------------------------------------------

def test_search_forwards_threshold_as_min_similarity(client):
    """`threshold` must reach the engine as `minSimilarity`, and `mode` not at all."""
    _, args = _call(client, "/search", {"query": "q", "mode": "semantic", "threshold": 0.42})
    assert args["minSimilarity"] == pytest.approx(0.42)
    assert "threshold" not in args
    assert "mode" not in args


def test_importance_score_forwards_context_topics_as_camel_case(client):
    """ImportanceArgs is camelCase-only; snake_case would be silently dropped."""
    _, args = _call(client, "/importance_score", {"content": "c", "context_topics": ["x"]})
    assert args["contextTopics"] == ["x"]
    assert "context_topics" not in args


def test_predict_context_survives_the_agent_header(client):
    """Agent identity must not overwrite predict's structured context."""
    _, args = _call(
        client, "/predict", {"context": {"current_file": "a.py", "current_topics": ["x"]}}
    )
    assert isinstance(args["context"], dict)
    assert args["context"]["current_file"] == "a.py"
    assert args["context"]["current_topics"] == ["agent:tank", "x"]


def test_intention_context_is_an_object_not_a_string(client):
    """A string `context` here fails engine deserialization outright."""
    _, args = _call(client, "/intention", {"action": "check"})
    assert isinstance(args["context"], dict)
    assert args["context"]["topics"] == ["agent:tank"]


def test_intention_trigger_multi_word_fields_are_camel_case(client):
    """TriggerSpec is camelCase-only — snake_case trigger fields are dropped."""
    _, args = _call(
        client,
        "/intention",
        {
            "action": "set",
            "description": "d",
            "trigger": {"type": "time", "in_minutes": 30, "file_pattern": "*.py"},
        },
    )
    trigger = args["trigger"]
    assert trigger["inMinutes"] == 30
    assert trigger["filePattern"] == "*.py"
    assert "in_minutes" not in trigger
    assert "file_pattern" not in trigger


def test_ingest_context_becomes_source_provenance(client):
    """smart_ingest has no `context`; caller context belongs in `source`."""
    _, args = _call(client, "/smart_ingest", {"content": "c", "context": "review notes"})
    assert args["source"] == "agent:tank | review notes"
    assert "context" not in args
