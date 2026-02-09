"""Bearer-token authentication middleware for the Vestige HTTP bridge."""

from __future__ import annotations

import os
import secrets

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

# Paths that bypass authentication
_PUBLIC_PATHS = {"/health", "/readyz", "/docs", "/openapi.json", "/redoc"}


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Reject requests without a valid Bearer token.

    The expected token is read from the ``VESTIGE_AUTH_TOKEN`` environment
    variable.  Auth is **required by default**.  To explicitly allow
    unauthenticated access (e.g. local dev), you must:

      1. Leave ``VESTIGE_AUTH_TOKEN`` **unset** (not empty), AND
      2. Set ``VESTIGE_ALLOW_ANONYMOUS=true``

    An empty-string token is treated as invalid — it does **not** disable auth.
    Token comparison uses ``secrets.compare_digest`` to prevent timing attacks.
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        # Check if token env var is set (distinguishing unset from empty)
        token_is_set = "VESTIGE_AUTH_TOKEN" in os.environ
        expected = os.environ.get("VESTIGE_AUTH_TOKEN", "")

        # Treat empty string as "not configured" (same as unset)
        if token_is_set and not expected:
            # Empty token configured — refuse to run in insecure mode
            return JSONResponse(
                {"detail": "VESTIGE_AUTH_TOKEN is set but empty — provide a valid token"},
                status_code=500,
            )

        if not token_is_set:
            # Token is not set at all — check if anonymous access is explicitly allowed
            allow_anon = os.environ.get("VESTIGE_ALLOW_ANONYMOUS", "").lower() == "true"
            if allow_anon:
                return await call_next(request)
            return JSONResponse(
                {
                    "detail": "Authentication not configured. Set VESTIGE_AUTH_TOKEN or "
                    "VESTIGE_ALLOW_ANONYMOUS=true for open access."
                },
                status_code=500,
            )

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return JSONResponse({"detail": "Invalid or missing bearer token"}, status_code=401)

        provided = auth[7:]
        if not secrets.compare_digest(provided.encode(), expected.encode()):
            return JSONResponse({"detail": "Invalid or missing bearer token"}, status_code=401)

        return await call_next(request)
