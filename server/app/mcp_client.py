"""MCP JSON-RPC 2.0 client communicating with vestige-mcp over stdio.

Transport framing: This client uses NDJSON (newline-delimited JSON) for the
stdio transport. Each JSON-RPC message is a single line terminated by ``\\n``.
This matches the Vestige MCP server implementation which is built on the
``rmcp`` Rust crate — rmcp uses NDJSON framing for stdio (not LSP-style
``Content-Length`` headers). This is the most common framing for MCP stdio
transports.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

logger = logging.getLogger("vestige.mcp")


class MCPClient:
    """Manages a vestige-mcp subprocess and speaks MCP JSON-RPC over its stdio."""

    def __init__(self, binary: str = "vestige-mcp", data_dir: str | None = None):
        self.binary = binary
        self.data_dir = data_dir
        self._proc: asyncio.subprocess.Process | None = None
        self._req_id = 0
        self._lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._started_at: float = 0.0
        self._tools: list[dict] = []
        self._available_tool_names: list[str] = []
        self._stderr_task: asyncio.Task | None = None

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Spawn vestige-mcp and perform MCP initialize handshake."""
        async with self._lifecycle_lock:
            # Don't spawn a duplicate if already alive
            if self.alive:
                logger.debug("start() called but process already alive, skipping")
                return

            cmd = [self.binary]
            if self.data_dir:
                cmd += ["--data-dir", self.data_dir]

            self._proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._started_at = time.monotonic()
            logger.info("vestige-mcp started (pid=%s)", self._proc.pid)

            # Drain stderr in the background to prevent pipe buffer deadlock
            self._stderr_task = asyncio.create_task(self._drain_stderr())

            # MCP initialize handshake
            resp = await self._send(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "openclaw-vestige-bridge", "version": "0.1.0"},
                },
            )
            self._tools = resp.get("capabilities", {}).get("tools", [])

            # Send initialized notification (no id → notification)
            await self._send_notification("notifications/initialized", {})
            logger.info("MCP initialized – capabilities report %d tools", len(self._tools))

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

    async def _drain_stderr(self) -> None:
        """Continuously read stderr to prevent pipe buffer deadlock."""
        while self._proc and self._proc.stderr:
            try:
                line = await self._proc.stderr.readline()
                if not line:
                    break
                logger.debug("vestige-mcp stderr: %s", line.decode().rstrip())
            except Exception:
                break

    async def stop(self) -> None:
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
            logger.info("vestige-mcp stopped")
        # Cancel stderr drainer
        if self._stderr_task and not self._stderr_task.done():
            self._stderr_task.cancel()
            self._stderr_task = None
        self._proc = None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def uptime(self) -> float:
        return time.monotonic() - self._started_at if self._started_at else 0.0

    @property
    def tool_names(self) -> list[str]:
        """Return the list of tool names discovered from Vestige."""
        return list(self._available_tool_names)

    async def ensure_alive(self) -> None:
        """Restart the subprocess if it has died (serialized with lifecycle lock)."""
        async with self._lifecycle_lock:
            if not self.alive:
                logger.warning("vestige-mcp not alive – restarting")
                # Release lifecycle lock internally — start() re-acquires it,
                # but since we hold it here we call _start_unlocked instead.
                await self._start_unlocked()

    async def _start_unlocked(self) -> None:
        """Internal start without acquiring _lifecycle_lock (caller must hold it)."""
        if self.alive:
            return

        cmd = [self.binary]
        if self.data_dir:
            cmd += ["--data-dir", self.data_dir]

        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._started_at = time.monotonic()
        logger.info("vestige-mcp started (pid=%s)", self._proc.pid)

        # Drain stderr in the background to prevent pipe buffer deadlock
        self._stderr_task = asyncio.create_task(self._drain_stderr())

        # MCP initialize handshake
        resp = await self._send(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "openclaw-vestige-bridge", "version": "0.1.0"},
            },
        )
        self._tools = resp.get("capabilities", {}).get("tools", [])

        await self._send_notification("notifications/initialized", {})
        logger.info("MCP initialized – capabilities report %d tools", len(self._tools))

        await self._discover_tools()

    # ── tool invocation ───────────────────────────────────────────────────

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """Call an MCP tool and return the parsed result content."""
        await self.ensure_alive()
        resp = await self._send("tools/call", {"name": name, "arguments": arguments})
        # MCP tools/call returns { content: [...] } or { isError: true, content: [...] }
        if resp.get("isError"):
            texts = [c.get("text", "") for c in resp.get("content", [])]
            raise MCPToolError(" ".join(texts))
        # Extract content array from result for proper response handling
        content = resp.get("content", [])
        return {"content": content}

    # ── low-level JSON-RPC ────────────────────────────────────────────────

    async def _send(self, method: str, params: dict) -> dict:
        async with self._lock:
            self._req_id += 1
            msg = {
                "jsonrpc": "2.0",
                "id": self._req_id,
                "method": method,
                "params": params,
            }
            return await self._roundtrip(msg)

    async def _send_notification(self, method: str, params: dict) -> None:
        async with self._lock:
            msg = {"jsonrpc": "2.0", "method": method, "params": params}
            await self._write(msg)

    async def _roundtrip(self, msg: dict) -> dict:
        await self._write(msg)
        return await self._read_response(msg["id"])

    async def _write(self, msg: dict) -> None:
        if not self._proc or not self._proc.stdin:
            raise MCPConnectionError("vestige-mcp process not available (stdin closed)")
        line = json.dumps(msg) + "\n"
        self._proc.stdin.write(line.encode())
        await self._proc.stdin.drain()

    async def _read_response(self, expected_id: int) -> dict:
        if not self._proc or not self._proc.stdout:
            raise MCPConnectionError("vestige-mcp process not available (stdout closed)")
        while True:
            raw = await asyncio.wait_for(self._proc.stdout.readline(), timeout=30)
            if not raw:
                raise MCPConnectionError("vestige-mcp closed stdout unexpectedly")
            line = raw.decode().strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("non-JSON from vestige-mcp: %s", line)
                continue

            # Skip notifications (no id)
            if "id" not in data:
                continue
            if data["id"] != expected_id:
                logger.warning("unexpected id %s (expected %s)", data["id"], expected_id)
                continue

            if "error" in data:
                err = data["error"]
                raise MCPError(f"MCP error {err.get('code')}: {err.get('message')}")
            return data.get("result", {})


class MCPError(Exception):
    pass


class MCPConnectionError(MCPError):
    pass


class MCPToolError(MCPError):
    pass
