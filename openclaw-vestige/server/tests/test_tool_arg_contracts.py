"""Contract tests: every argument the bridge sends must exist in the engine schema.

The engine (vestige-mcp) owns the tool contract. The bridge translates REST
requests into MCP tool calls, and the two drift — openclaw-vestige-ow6 was
``/memory`` sending ``memory_id`` when the tool requires ``id``, which made the
endpoint fail on every call. Nothing caught it because nothing compared the
bridge's constructed arguments against the tool schemas.

This module does that comparison for *every* POST endpoint, so the whole drift
class is covered rather than the one instance:

  * every endpoint is exercised (``test_every_post_endpoint_is_covered``);
  * the tool name must be one the engine advertises;
  * every ``required`` property must be present;
  * every argument sent must be a declared property (recursively, for nested
    objects) — no silently-discarded arguments;
  * declared ``type`` and ``enum`` constraints must hold.

The schemas live in ``vestige_tool_schemas.json``; see its ``_meta`` block for
provenance and the refresh command.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import (
    _INTENTION_CONTEXT_ALIASES,
    _INTENTION_TRIGGER_ALIASES,
    _WIRE_ALIASES,
)

_SCHEMAS = json.loads((Path(__file__).parent / "vestige_tool_schemas.json").read_text())["tools"]

#: Nested-object alias maps, keyed by (tool, property).
_NESTED_ALIASES = {
    ("intention", "trigger"): _INTENTION_TRIGGER_ALIASES,
    ("intention", "context"): _INTENTION_CONTEXT_ALIASES,
}


# ---------------------------------------------------------------------------
# Effective schemas — published schema with engine wire aliases applied
# ---------------------------------------------------------------------------

def _rename_properties(schema: dict, aliases: dict[str, str]) -> dict:
    """Rename a schema's property keys (and any required entries) via ``aliases``."""
    if not aliases:
        return schema
    renamed = dict(schema)
    renamed["properties"] = {
        aliases.get(key, key): value for key, value in schema.get("properties", {}).items()
    }
    if "required" in schema:
        renamed["required"] = [aliases.get(key, key) for key in schema["required"]]
    return renamed


def _effective_schema(tool: str) -> dict:
    """The schema as the engine's *deserializer* sees it, not as it publishes it."""
    schema = _rename_properties(_SCHEMAS[tool], _WIRE_ALIASES.get(tool, {}))
    properties = dict(schema.get("properties", {}))
    for (alias_tool, prop), aliases in _NESTED_ALIASES.items():
        if alias_tool == tool and prop in properties:
            properties[prop] = _rename_properties(properties[prop], aliases)
    return {**schema, "properties": properties}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

_TYPE_CHECKS = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _check_type(where: str, declared: str | None, value) -> list[str]:
    if declared is None or value is None:
        return []
    expected = _TYPE_CHECKS.get(declared)
    if expected is None:
        return []
    # bool is a subclass of int — reject it for integer/number properties.
    if declared in ("integer", "number") and isinstance(value, bool):
        return [f"{where}: expected {declared}, got bool"]
    if not isinstance(value, expected):
        return [f"{where}: expected {declared}, got {type(value).__name__}"]
    return []


def _validate(tool: str, args: dict, schema: dict, path: str = "") -> list[str]:
    """Return a list of contract violations (empty means the args are valid)."""
    problems: list[str] = []
    properties = schema.get("properties", {})

    for key in schema.get("required", []):
        if key not in args:
            problems.append(f"{tool}{path}: missing required argument '{key}'")

    for key, value in args.items():
        where = f"{tool}{path}.{key}"
        if key not in properties:
            problems.append(
                f"{where}: not a property of the engine schema "
                f"(declared: {sorted(properties)})"
            )
            continue
        prop = properties[key]
        problems += _check_type(where, prop.get("type"), value)
        if (allowed := prop.get("enum")) and value not in allowed:
            problems.append(f"{where}: {value!r} not in enum {allowed}")
        if prop.get("type") == "object" and isinstance(value, dict) and "properties" in prop:
            problems += _validate(tool, value, prop, path=f"{path}.{key}")

    return problems


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def calls(monkeypatch):
    """Drive the app against a recording MCP client; yields (client, recorded)."""
    monkeypatch.setenv("VESTIGE_ALLOW_ANONYMOUS", "true")
    monkeypatch.delenv("VESTIGE_AUTH_TOKEN", raising=False)

    recorded: list[tuple[str, dict]] = []

    async def _record(name, arguments):
        recorded.append((name, arguments))
        return {"content": []}

    mock = AsyncMock()
    mock.alive = True
    mock.uptime = 0.0
    mock.tool_names = list(_SCHEMAS)
    mock.connect = AsyncMock()
    mock.disconnect = AsyncMock()
    mock.health_check = AsyncMock(return_value=True)
    mock.call_tool = AsyncMock(side_effect=_record)

    with patch("app.main.mcp", mock):
        from app.main import app

        with TestClient(app, raise_server_exceptions=True) as client:
            yield client, recorded


# ---------------------------------------------------------------------------
# The request table — one or more representative payloads per endpoint
# ---------------------------------------------------------------------------

_MEMORY_ID = "3f0f8c9e-1c2b-4a5d-8e7f-0a1b2c3d4e5f"

REQUESTS: list[tuple[str, dict]] = [
    ("/search", {"query": "q"}),
    ("/search", {"query": "q", "mode": "semantic", "limit": 5, "threshold": 0.42}),
    ("/ingest", {"content": "c"}),
    ("/ingest", {"content": "c", "node_type": "note", "tags": ["t"], "context": "ctx"}),
    ("/smart_ingest", {"content": "c", "tags": ["t"], "context": "ctx"}),
    ("/promote", {"memory_id": _MEMORY_ID}),
    ("/demote", {"memory_id": _MEMORY_ID}),
    ("/memory", {"action": "get", "memory_id": _MEMORY_ID}),
    ("/memory", {"action": "delete", "memory_id": _MEMORY_ID}),
    ("/memory", {"action": "state", "memory_id": _MEMORY_ID}),
    ("/memory", {"action": "check_state", "memory_id": _MEMORY_ID}),
    ("/memory", {"action": "promote", "memory_id": _MEMORY_ID, "reason": "helpful"}),
    ("/memory", {"action": "demote", "memory_id": _MEMORY_ID, "reason": "wrong"}),
    ("/memory", {"action": "edit", "memory_id": _MEMORY_ID, "content": "new"}),
    (
        "/codebase",
        {
            "action": "remember_pattern",
            "name": "Bridge arg translation",
            "description": "Send the engine's argument names.",
            "files": ["server/app/main.py"],
            "codebase": "openclaw-vestige",
        },
    ),
    (
        "/codebase",
        {
            "action": "remember_decision",
            "decision": "Bridge matches the engine schema",
            "rationale": "The engine owns the contract.",
            "alternatives": ["Change the Rust schema"],
        },
    ),
    ("/codebase", {"action": "get_context", "codebase": "openclaw-vestige", "limit": 5}),
    (
        "/intention",
        {
            "action": "set",
            "description": "Refresh the schema snapshot",
            "priority": "high",
            "trigger": {"type": "time", "in_minutes": 30},
        },
    ),
    ("/intention", {"action": "check", "context": {"codebase": "vestige", "topics": ["mcp"]}}),
    ("/intention", {"action": "check"}),
    ("/intention", {"action": "update", "id": _MEMORY_ID, "status": "snooze", "snooze_minutes": 15}),
    ("/intention", {"action": "list", "filter_status": "active", "limit": 20}),
    ("/dream", {}),
    ("/dream", {"memory_count": 10}),
    ("/session_context", {}),
    (
        "/session_context",
        {"queries": ["prefs"], "context": {"codebase": "vestige", "topics": ["mcp"]}},
    ),
    ("/explore_connections", {"action": "associations", "from": _MEMORY_ID}),
    ("/explore_connections", {"action": "chain", "from": _MEMORY_ID, "to": _MEMORY_ID}),
    ("/predict", {}),
    ("/predict", {"context": {"codebase": "vestige", "current_topics": ["mcp"]}}),
    ("/importance_score", {"content": "c"}),
    ("/importance_score", {"content": "c", "context_topics": ["mcp"], "project": "vestige"}),
    ("/consolidate", {}),
    ("/backup", {}),
]

#: Sent on half the requests so agent-identity handling is covered too.
_AGENT_HEADER = {"X-Agent-Id": "narcissus"}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_every_post_endpoint_is_covered(calls):
    """A new endpoint must be added to REQUESTS — no silent gaps in coverage."""
    client, _ = calls
    routes = {
        route.path
        for route in client.app.routes
        if "POST" in getattr(route, "methods", set())
    }
    assert routes - {path for path, _ in REQUESTS} == set()


@pytest.mark.parametrize("with_agent", [False, True], ids=["anonymous", "with-agent-id"])
@pytest.mark.parametrize("path,payload", REQUESTS, ids=[f"{p}{i}" for i, (p, _) in enumerate(REQUESTS)])
def test_bridge_args_match_engine_schema(calls, path, payload, with_agent):
    client, recorded = calls
    recorded.clear()

    resp = client.post(path, json=payload, headers=_AGENT_HEADER if with_agent else {})
    assert resp.status_code == 200, resp.text
    assert len(recorded) == 1, f"{path} made {len(recorded)} tool calls"

    tool, args = recorded[0]
    assert tool in _SCHEMAS, f"{path} calls '{tool}', which the engine does not advertise"

    problems = _validate(tool, args, _effective_schema(tool))
    assert not problems, f"{path} -> {tool}({args}):\n  " + "\n  ".join(problems)


def test_wire_aliases_only_rename_real_properties():
    """A stale alias entry would silently stop protecting anything."""
    for tool, aliases in _WIRE_ALIASES.items():
        properties = _SCHEMAS[tool]["properties"]
        for published in aliases:
            assert published in properties, f"{tool}.{published} is not a published property"
    for (tool, prop), aliases in _NESTED_ALIASES.items():
        properties = _SCHEMAS[tool]["properties"][prop]["properties"]
        for published in aliases:
            assert published in properties, f"{tool}.{prop}.{published} is not published"


# ---------------------------------------------------------------------------
# Targeted regression tests for openclaw-vestige-ow6
# ---------------------------------------------------------------------------

def test_memory_endpoint_sends_id_not_memory_id(calls):
    """openclaw-vestige-ow6: the tool requires 'id'; 'memory_id' failed every call."""
    client, recorded = calls
    recorded.clear()

    resp = client.post("/memory", json={"action": "get", "memory_id": _MEMORY_ID})
    assert resp.status_code == 200

    tool, args = recorded[0]
    assert tool == "memory"
    assert args["id"] == _MEMORY_ID
    assert "memory_id" not in args


def test_memory_check_state_maps_to_engine_state_action(calls):
    """The REST enum carried 'check_state'; the engine only accepts 'state'."""
    client, recorded = calls
    recorded.clear()

    resp = client.post("/memory", json={"action": "check_state", "memory_id": _MEMORY_ID})
    assert resp.status_code == 200
    assert recorded[0][1]["action"] == "state"


def test_search_threshold_is_forwarded_as_min_similarity(calls):
    """'threshold' is not a search property — it was silently discarded."""
    client, recorded = calls
    recorded.clear()

    resp = client.post("/search", json={"query": "q", "threshold": 0.75})
    assert resp.status_code == 200

    args = recorded[0][1]
    assert args["minSimilarity"] == 0.75
    assert "threshold" not in args
    assert "mode" not in args


def test_predict_agent_id_does_not_clobber_context(calls):
    """The old _agent_context replaced the context object with a string."""
    client, recorded = calls
    recorded.clear()

    resp = client.post(
        "/predict",
        json={"context": {"codebase": "vestige", "current_topics": ["mcp"]}},
        headers=_AGENT_HEADER,
    )
    assert resp.status_code == 200

    context = recorded[0][1]["context"]
    assert isinstance(context, dict)
    assert context["codebase"] == "vestige"
    assert context["current_topics"] == ["agent:narcissus", "mcp"]


def test_ingest_carries_agent_identity_in_source(calls):
    """smart_ingest has no 'context' property; provenance belongs in 'source'."""
    client, recorded = calls
    recorded.clear()

    resp = client.post("/ingest", json={"content": "c", "context": "ctx"}, headers=_AGENT_HEADER)
    assert resp.status_code == 200

    tool, args = recorded[0]
    assert tool == "smart_ingest"
    assert args["source"] == "agent:narcissus | ctx"
    assert "context" not in args
    assert "agent_id" not in args
