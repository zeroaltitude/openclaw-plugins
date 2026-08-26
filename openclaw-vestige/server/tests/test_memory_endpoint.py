"""Tests for the argument names /memory, /promote and /demote send to the engine.

The engine's `memory` tool declares `required: ["action", "id"]` and
`action` enum ["get", "delete", "state", "promote", "demote", "edit"]
(vestige: crates/vestige-mcp/src/tools/memory_unified.rs). The bridge's REST
surface names the same field `memory_id` and historically accepted
`check_state`, so both need translating on the way out. Getting this wrong is
invisible at the REST layer — the engine just answers
"Invalid arguments: missing field `id`" (openclaw-vestige-ow6).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.models import MEMORY_ACTION_ALIASES, MemoryAction

# Patch the MCP client at import time so lifespan doesn't try to connect.
_mock_mcp = AsyncMock()
_mock_mcp.alive = True
_mock_mcp.uptime = 0.0
_mock_mcp.tool_names = ["memory"]
_mock_mcp.connect = AsyncMock()
_mock_mcp.disconnect = AsyncMock()
_mock_mcp.health_check = AsyncMock(return_value=True)

#: The `action` enum the engine's memory tool accepts. Keep in sync with
#: crates/vestige-mcp/src/tools/memory_unified.rs.
ENGINE_ACTIONS = {"get", "delete", "state", "promote", "demote", "edit"}

MEMORY_UUID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"


@pytest.fixture()
def client(monkeypatch):
    """TestClient with a mocked MCP client and no auth."""
    monkeypatch.setenv("VESTIGE_ALLOW_ANONYMOUS", "true")
    monkeypatch.delenv("VESTIGE_AUTH_TOKEN", raising=False)

    with patch("app.main.mcp", _mock_mcp):
        from app.main import app

        with TestClient(app, raise_server_exceptions=True) as c:
            yield c


def _sent_args() -> dict:
    """The arguments dict from the most recent call_tool invocation."""
    name, args = _mock_mcp.call_tool.await_args.args
    assert name == "memory"
    return args


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("action", ["get", "delete", "promote", "demote"])
def test_memory_sends_id_not_memory_id(client, action):
    """/memory forwards the REST `memory_id` as the engine's `id`."""
    _mock_mcp.call_tool = AsyncMock(return_value={"action": action, "found": True})

    resp = client.post("/memory", json={"action": action, "memory_id": MEMORY_UUID})
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    args = _sent_args()
    assert args["id"] == MEMORY_UUID
    assert "memory_id" not in args
    assert args["action"] == action


def test_memory_translates_check_state_to_state(client):
    """The bridge's legacy `check_state` becomes the engine's `state`."""
    _mock_mcp.call_tool = AsyncMock(return_value={"action": "state"})

    resp = client.post("/memory", json={"action": "check_state", "memory_id": MEMORY_UUID})
    assert resp.status_code == 200

    args = _sent_args()
    assert args["action"] == "state"
    assert args["id"] == MEMORY_UUID


def test_memory_accepts_state_directly(client):
    """`state` is the canonical spelling and passes through untranslated."""
    _mock_mcp.call_tool = AsyncMock(return_value={"action": "state"})

    resp = client.post("/memory", json={"action": "state", "memory_id": MEMORY_UUID})
    assert resp.status_code == 200
    assert _sent_args()["action"] == "state"


def test_memory_agent_id_does_not_displace_id(client):
    """X-Agent-Id must not displace `id` — and is deliberately not forwarded.

    The engine's memory tool declares no `agent_id` property and its structs
    do not use deny_unknown_fields, so an `agent_id` argument would be
    silently dropped on the wire. The bridge sends nothing rather than an
    argument the engine will discard.
    """
    _mock_mcp.call_tool = AsyncMock(return_value={"action": "get"})

    resp = client.post(
        "/memory",
        json={"action": "get", "memory_id": MEMORY_UUID},
        headers={"X-Agent-Id": "shiva"},
    )
    assert resp.status_code == 200

    args = _sent_args()
    assert args["id"] == MEMORY_UUID
    assert "agent_id" not in args


@pytest.mark.parametrize("endpoint", ["/promote", "/demote"])
def test_promote_demote_send_id(client, endpoint):
    """The dedicated promote/demote endpoints use the same `id` argument."""
    _mock_mcp.call_tool = AsyncMock(return_value={"action": endpoint.lstrip("/")})

    resp = client.post(endpoint, json={"memory_id": MEMORY_UUID})
    assert resp.status_code == 200

    args = _sent_args()
    assert args["id"] == MEMORY_UUID
    assert args["action"] == endpoint.lstrip("/")


def test_every_bridge_action_is_known_to_the_engine():
    """No bridge action may reach the engine as an action it doesn't declare.

    This is the drift guard: adding a MemoryAction the engine doesn't know
    fails here unless MEMORY_ACTION_ALIASES translates it.
    """
    for action in MemoryAction:
        engine_action = MEMORY_ACTION_ALIASES.get(action.value, action.value)
        assert engine_action in ENGINE_ACTIONS, (
            f"MemoryAction.{action.name} maps to {engine_action!r}, "
            f"which the engine's memory tool does not accept"
        )
