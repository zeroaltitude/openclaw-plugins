"""Tests for bearer auth middleware."""

import os
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import PlainTextResponse

from app.auth import BearerAuthMiddleware


def _make_app(token: str | None = None) -> TestClient:
    app = FastAPI()
    app.add_middleware(BearerAuthMiddleware)

    @app.get("/health")
    async def health():
        return PlainTextResponse("ok")

    @app.get("/protected")
    async def protected():
        return PlainTextResponse("secret")

    if token:
        os.environ["VESTIGE_AUTH_TOKEN"] = token
    else:
        os.environ.pop("VESTIGE_AUTH_TOKEN", None)
    return TestClient(app)


def test_no_token_env_allows_all():
    client = _make_app(token=None)
    resp = client.get("/protected")
    assert resp.status_code == 200


def test_health_bypasses_auth():
    client = _make_app(token="secret123")
    resp = client.get("/health")
    assert resp.status_code == 200
    os.environ.pop("VESTIGE_AUTH_TOKEN", None)


def test_missing_header_returns_401():
    client = _make_app(token="secret123")
    resp = client.get("/protected")
    assert resp.status_code == 401
    os.environ.pop("VESTIGE_AUTH_TOKEN", None)


def test_wrong_token_returns_401():
    client = _make_app(token="secret123")
    resp = client.get("/protected", headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 401
    os.environ.pop("VESTIGE_AUTH_TOKEN", None)


def test_correct_token_passes():
    client = _make_app(token="secret123")
    resp = client.get("/protected", headers={"Authorization": "Bearer secret123"})
    assert resp.status_code == 200
    os.environ.pop("VESTIGE_AUTH_TOKEN", None)
