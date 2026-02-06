"""Tests for bearer auth middleware."""

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import PlainTextResponse

from app.auth import BearerAuthMiddleware


def _make_app(
    token: str | None = None,
    allow_anonymous: bool = False,
) -> TestClient:
    """Create a test app with the auth middleware and given env configuration."""
    app = FastAPI()
    app.add_middleware(BearerAuthMiddleware)

    @app.get("/health")
    async def health():
        return PlainTextResponse("ok")

    @app.get("/readyz")
    async def readyz():
        return PlainTextResponse("ready")

    @app.get("/protected")
    async def protected():
        return PlainTextResponse("secret")

    # Clean env
    os.environ.pop("VESTIGE_AUTH_TOKEN", None)
    os.environ.pop("VESTIGE_ALLOW_ANONYMOUS", None)

    if token is not None:
        os.environ["VESTIGE_AUTH_TOKEN"] = token
    if allow_anonymous:
        os.environ["VESTIGE_ALLOW_ANONYMOUS"] = "true"

    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_env():
    """Ensure environment is clean after each test."""
    yield
    os.environ.pop("VESTIGE_AUTH_TOKEN", None)
    os.environ.pop("VESTIGE_ALLOW_ANONYMOUS", None)


def test_no_token_no_anon_returns_500():
    """Without token and without VESTIGE_ALLOW_ANONYMOUS, return 500."""
    client = _make_app(token=None, allow_anonymous=False)
    resp = client.get("/protected")
    assert resp.status_code == 500
    assert "VESTIGE_AUTH_TOKEN" in resp.json()["detail"]


def test_no_token_with_anon_allows_all():
    """Without token but with VESTIGE_ALLOW_ANONYMOUS=true, allow access."""
    client = _make_app(token=None, allow_anonymous=True)
    resp = client.get("/protected")
    assert resp.status_code == 200


def test_empty_token_returns_500():
    """Empty string token is treated as misconfiguration, not open access."""
    client = _make_app(token="")
    resp = client.get("/protected")
    assert resp.status_code == 500


def test_health_bypasses_auth():
    client = _make_app(token="secret123")
    resp = client.get("/health")
    assert resp.status_code == 200


def test_readyz_bypasses_auth():
    client = _make_app(token="secret123")
    resp = client.get("/readyz")
    assert resp.status_code == 200


def test_missing_header_returns_401():
    client = _make_app(token="secret123")
    resp = client.get("/protected")
    assert resp.status_code == 401


def test_wrong_token_returns_401():
    client = _make_app(token="secret123")
    resp = client.get("/protected", headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 401


def test_correct_token_passes():
    client = _make_app(token="secret123")
    resp = client.get("/protected", headers={"Authorization": "Bearer secret123"})
    assert resp.status_code == 200
