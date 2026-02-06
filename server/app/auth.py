"""Bearer-token authentication middleware for the Vestige HTTP bridge."""

from __future__ import annotations

import os

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

# Paths that bypass authentication
_PUBLIC_PATHS = {"/health", "/docs", "/openapi.json", "/redoc"}


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Reject requests without a valid Bearer token.

    The expected token is read from the ``VESTIGE_AUTH_TOKEN`` environment
    variable.  If the variable is unset the middleware is a no-op (open
    access), which is convenient for local development.
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        expected = os.environ.get("VESTIGE_AUTH_TOKEN")
        if not expected:
            return await call_next(request)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] != expected:
            return JSONResponse({"detail": "Invalid or missing bearer token"}, status_code=401)

        return await call_next(request)
