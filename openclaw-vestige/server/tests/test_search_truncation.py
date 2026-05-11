"""Tests for body truncation on /search responses."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Patch the MCP client at import time so lifespan doesn't try to connect.
_mock_mcp = AsyncMock()
_mock_mcp.alive = True
_mock_mcp.uptime = 0.0
_mock_mcp.tool_names = ["search"]
_mock_mcp.connect = AsyncMock()
_mock_mcp.disconnect = AsyncMock()
_mock_mcp.health_check = AsyncMock(return_value=True)


@pytest.fixture()
def client(monkeypatch):
    """TestClient with a mocked MCP client and no auth."""
    monkeypatch.setenv("VESTIGE_ALLOW_ANONYMOUS", "true")
    monkeypatch.delenv("VESTIGE_AUTH_TOKEN", raising=False)

    with patch("app.main.mcp", _mock_mcp):
        from app.main import app

        with TestClient(app, raise_server_exceptions=True) as c:
            yield c


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_search_result(body: str) -> dict:
    """Build a minimal MCP tool result containing one search result."""
    return {
        "results": [
            {
                "id": "mem-001",
                "score": 0.95,
                "body": body,
            }
        ]
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_truncation_applied_when_body_exceeds_cap(client):
    """Bodies larger than truncate_body_chars are truncated and body_length added."""
    big_body = "x" * 100_000  # 100 KB
    _mock_mcp.call_tool = AsyncMock(return_value=_make_search_result(big_body))

    resp = client.post("/search", json={"query": "test", "truncate_body_chars": 8000})
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True

    item = data["data"]["results"][0]
    assert item["body_length"] == 100_000
    assert len(item["body"]) == 8000
    assert item["body"] == "x" * 8000
    assert item["truncated_body"] == "x" * 8000


def test_no_truncation_when_body_within_cap(client):
    """Bodies smaller than the cap pass through unchanged, no body_length added."""
    small_body = "hello world"
    _mock_mcp.call_tool = AsyncMock(return_value=_make_search_result(small_body))

    resp = client.post("/search", json={"query": "test", "truncate_body_chars": 8000})
    assert resp.status_code == 200
    item = resp.json()["data"]["results"][0]
    assert item["body"] == small_body
    assert "body_length" not in item


def test_truncation_disabled_when_null(client):
    """truncate_body_chars=null disables truncation entirely."""
    big_body = "y" * 50_000
    _mock_mcp.call_tool = AsyncMock(return_value=_make_search_result(big_body))

    resp = client.post("/search", json={"query": "test", "truncate_body_chars": None})
    assert resp.status_code == 200
    item = resp.json()["data"]["results"][0]
    assert item["body"] == big_body
    assert "body_length" not in item


def test_truncation_disabled_when_zero(client):
    """truncate_body_chars=0 disables truncation."""
    big_body = "z" * 50_000
    _mock_mcp.call_tool = AsyncMock(return_value=_make_search_result(big_body))

    resp = client.post("/search", json={"query": "test", "truncate_body_chars": 0})
    assert resp.status_code == 200
    item = resp.json()["data"]["results"][0]
    assert item["body"] == big_body
    assert "body_length" not in item


def test_default_truncation_cap_is_8000(client):
    """Omitting truncate_body_chars uses the 8000-char default."""
    big_body = "a" * 20_000
    _mock_mcp.call_tool = AsyncMock(return_value=_make_search_result(big_body))

    resp = client.post("/search", json={"query": "test"})
    assert resp.status_code == 200
    item = resp.json()["data"]["results"][0]
    assert item["body_length"] == 20_000
    assert len(item["body"]) == 8000


def test_truncation_also_handles_content_field(client):
    """The 'content' field is also truncated (alternate field name used by some tools)."""
    big_content = "c" * 20_000
    result = {"results": [{"id": "m2", "score": 0.8, "content": big_content}]}
    _mock_mcp.call_tool = AsyncMock(return_value=result)

    resp = client.post("/search", json={"query": "test"})
    assert resp.status_code == 200
    item = resp.json()["data"]["results"][0]
    assert item["body_length"] == 20_000
    assert len(item["content"]) == 8000
