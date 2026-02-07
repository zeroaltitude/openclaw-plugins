"""MCP JSON-RPC 2.0 client communicating with an external Vestige MCP server.

Transport: Connects to a standalone Vestige instance exposed via Streamable HTTP
(supergateway) or SSE. No subprocess management — the Vestige process runs
independently and the bridge connects as a client.

Supported transports:
  - streamable_http (default): POST JSON-RPC to /mcp endpoint
  - sse: GET /sse for server-sent events, POST /message for requests
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger("vestige.mcp")

# ── Configuration ─────────────────────────────────────────────────────────────

VESTIGE_MCP_URL = os.environ.get("VESTIGE_MCP_URL", "http://localhost:3100/mcp")
VESTIGE_TRANSPORT = os.environ.get("VESTIGE_TRANSPORT", "streamable_http")
REQUEST_TIMEOUT = float(os.environ.get("VESTIGE_REQUEST_TIMEOUT", "30"))


class MCPClient:
    """Connects to an external Vestige MCP server over HTTP (Streamable HTTP or SSE)."""

    def __init__(
        self,
        url: str | None = None,
        transport: str | None = None,
        timeout: float | None = None,
    ):
        self.url = url or VESTIGE_MCP_URL
        self.transport = transport or VESTIGE_TRANSPORT
        self.timeout = timeout or REQUEST_TIMEOUT
        self._req_id = 0
        self._client: httpx.AsyncClient | None = None
        self._connected = False
        self._connected_at: float = 0.0
        self._tools: list[dict] = []
        self._available_tool_names: list[str] = []
        self._session_id: str | None = None  # Mcp-Session-Id for stateful mode

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Initialize the HTTP client and perform MCP handshake with Vestige."""
        self._client = httpx.AsyncClient(timeout=self.timeout)

        # MCP initialize handshake
        resp = await self._send(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "openclaw-vestige-bridge", "version": "0.2.0"},
            },
        )
        self._tools = resp.get("capabilities", {}).get("tools", [])

        # Send initialized notification (no id → notification)
        await self._send_notification("notifications/initialized", {})
        self._connected = True
        self._connected_at = time.monotonic()
        logger.info("MCP initialized via %s – capabilities report %d tools", self.transport, len(self._tools))

        # Discover actual tool names via tools/list
        await self._discover_tools()

    async def _discover_tools(self) -> None:
        """Call tools/list to discover the actual tool names from Vestige."""
        try:
            resp = await self._send("tools/list", {})
            tools = resp.get("tools", [])
            self._available_tool_names = [t.get("name", "") for t in tools]
            logger.info(
                "Vestige tools discovered (%d): %s",
                len(self._available_tool_names),
                ", ".join(self._available_tool_names),
            )
        except MCPError as exc:
            logger.warning("Failed to list tools (non-fatal): %s", exc)
            self._available_tool_names = []

    async def disconnect(self) -> None:
        """Close the HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None
        self._connected = False
        self._session_id = None
        logger.info("MCP client disconnected")

    @property
    def alive(self) -> bool:
        """Check if we have an active connection to Vestige."""
        return self._connected and self._client is not None

    @property
    def uptime(self) -> float:
        return time.monotonic() - self._connected_at if self._connected_at else 0.0

    @property
    def tool_names(self) -> list[str]:
        """Return the list of tool names discovered from Vestige."""
        return list(self._available_tool_names)

    async def health_check(self) -> bool:
        """Check if the Vestige MCP endpoint is reachable.

        Sends a lightweight JSON-RPC ping (tools/list) to verify connectivity.
        Returns True if reachable, False otherwise.
        """
        try:
            if not self._client:
                self._client = httpx.AsyncClient(timeout=self.timeout)
            await self._send("tools/list", {})
            return True
        except Exception as exc:
            logger.warning("Vestige health check failed: %s", exc)
            return False

    async def ensure_connected(self) -> None:
        """Reconnect if the connection has been lost."""
        if not self.alive:
            logger.warning("Vestige connection lost – reconnecting")
            await self.connect()

    # ── tool invocation ───────────────────────────────────────────────────

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call an MCP tool and return the parsed result content."""
        await self.ensure_connected()
        resp = await self._send("tools/call", {"name": name, "arguments": arguments})
        # MCP tools/call returns { content: [...] } or { isError: true, content: [...] }
        if resp.get("isError"):
            texts = [c.get("text", "") for c in resp.get("content", [])]
            raise MCPToolError(" ".join(texts))
        # Extract content array from result for proper response handling
        content = resp.get("content", [])
        return {"content": content}

    # ── low-level JSON-RPC over HTTP ──────────────────────────────────────

    async def _send(self, method: str, params: dict) -> dict:
        """Send a JSON-RPC request and return the result."""
        self._req_id += 1
        msg = {
            "jsonrpc": "2.0",
            "id": self._req_id,
            "method": method,
            "params": params,
        }
        return await self._post_jsonrpc(msg)

    async def _send_notification(self, method: str, params: dict) -> None:
        """Send a JSON-RPC notification (no id, no response expected)."""
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        await self._post_jsonrpc_notification(msg)

    @staticmethod
    def _parse_sse_json(text: str) -> dict | list | None:
        """Extract JSON data from an SSE-formatted response.

        Supergateway returns Streamable HTTP responses as SSE:
            event: message
            data: {"jsonrpc":"2.0","id":1,"result":{...}}

        This extracts and parses the JSON from the 'data:' lines.
        """
        results = []
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload:
                    try:
                        results.append(json.loads(payload))
                    except json.JSONDecodeError:
                        continue
        if len(results) == 1:
            return results[0]
        elif len(results) > 1:
            return results
        return None

    async def _post_jsonrpc(self, msg: dict) -> dict:
        """POST a JSON-RPC message and parse the response."""
        if not self._client:
            raise MCPConnectionError("HTTP client not initialized — call connect() first")

        url = self._request_url()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        # Include session ID for stateful Streamable HTTP (required after initialize)
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id

        try:
            response = await self._client.post(url, json=msg, headers=headers)
            response.raise_for_status()
        except httpx.ConnectError as exc:
            self._connected = False
            raise MCPConnectionError(f"Cannot reach Vestige at {url}: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise MCPConnectionError(f"Timeout communicating with Vestige at {url}: {exc}") from exc
        except httpx.HTTPStatusError as exc:
            raise MCPError(f"Vestige returned HTTP {exc.response.status_code}: {exc.response.text}") from exc

        # Capture session ID from response (set by supergateway in stateful mode)
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            if self._session_id and self._session_id != session_id:
                logger.info("MCP session ID changed: %s → %s", self._session_id, session_id)
            self._session_id = session_id

        # Parse response — handle both JSON and SSE formats
        content_type = response.headers.get("content-type", "")
        data = None

        if "text/event-stream" in content_type:
            # Supergateway returns SSE-formatted responses
            data = self._parse_sse_json(response.text)
            if data is None:
                raise MCPError(f"No JSON data found in SSE response: {response.text[:200]}")
        else:
            # Standard JSON response
            try:
                data = response.json()
            except Exception as exc:
                # Last resort: try SSE parsing in case content-type is wrong
                data = self._parse_sse_json(response.text)
                if data is None:
                    raise MCPError(f"Invalid JSON from Vestige: {response.text[:200]}") from exc

        # Handle JSON-RPC batch or single response
        # Streamable HTTP may return an array; pick the response matching our id
        if isinstance(data, list):
            for item in data:
                if item.get("id") == msg.get("id"):
                    data = item
                    break
            else:
                # No matching id — use the first result-bearing item
                for item in data:
                    if "result" in item:
                        data = item
                        break
                else:
                    raise MCPError(f"No matching response in batch: {data}")

        if "error" in data:
            err = data["error"]
            raise MCPError(f"MCP error {err.get('code')}: {err.get('message')}")

        return data.get("result", {})

    async def _post_jsonrpc_notification(self, msg: dict) -> None:
        """POST a JSON-RPC notification (fire-and-forget)."""
        if not self._client:
            raise MCPConnectionError("HTTP client not initialized — call connect() first")

        url = self._request_url()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id

        try:
            response = await self._client.post(url, json=msg, headers=headers)
            # Capture session ID if present
            sid = response.headers.get("mcp-session-id")
            if sid:
                self._session_id = sid
            # Notifications may return 200 or 202, both are fine
            if response.status_code >= 400:
                logger.warning("Notification returned HTTP %d: %s", response.status_code, response.text[:200])
        except httpx.ConnectError as exc:
            self._connected = False
            raise MCPConnectionError(f"Cannot reach Vestige at {url}: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise MCPConnectionError(f"Timeout sending notification to Vestige: {exc}") from exc

    def _request_url(self) -> str:
        """Return the URL for sending JSON-RPC requests based on transport mode."""
        if self.transport == "sse":
            # SSE mode: requests go to /message, events come from /sse
            # Replace /sse suffix with /message if present, else append /message
            base = self.url.rstrip("/")
            if base.endswith("/sse"):
                return base[:-4] + "/message"
            return base + "/message"
        # streamable_http (default): POST directly to the URL
        return self.url


class MCPError(Exception):
    pass


class MCPConnectionError(MCPError):
    pass


class MCPToolError(MCPError):
    pass
