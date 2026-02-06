"""FastAPI HTTP bridge for vestige-mcp.

Spawns the vestige-mcp binary as a subprocess and translates incoming HTTP
requests into MCP JSON-RPC tool calls over stdin/stdout.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .auth import BearerAuthMiddleware
from .mcp_client import MCPClient, MCPError, MCPToolError
from .models import (
    CodebaseRequest,
    DemoteRequest,
    HealthResponse,
    IngestRequest,
    IntentionRequest,
    MemoryRequest,
    PromoteRequest,
    SearchRequest,
    SmartIngestRequest,
    VestigeResponse,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("vestige.server")

# ── MCP client singleton ─────────────────────────────────────────────────────

mcp = MCPClient(
    binary=os.environ.get("VESTIGE_BINARY", "vestige-mcp"),
    data_dir=os.environ.get("VESTIGE_DATA_DIR"),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await mcp.start()
    yield
    await mcp.stop()


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="OpenClaw Vestige Bridge",
    description="HTTP bridge to the Vestige cognitive memory MCP server",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(BearerAuthMiddleware)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _agent_context(agent_id: str | None) -> dict[str, Any]:
    """Build optional agent context dict."""
    if agent_id:
        return {"context": f"agent:{agent_id}"}
    return {}


async def _tool(name: str, arguments: dict[str, Any]) -> VestigeResponse:
    try:
        result = await mcp.call_tool(name, arguments)
        return VestigeResponse(success=True, data=result)
    except MCPToolError as exc:
        return VestigeResponse(success=False, error=str(exc))
    except MCPError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="healthy" if mcp.alive else "unhealthy",
        vestige_process=mcp.alive,
        uptime_seconds=round(mcp.uptime, 1),
    )


@app.post("/search", response_model=VestigeResponse)
async def search(
    req: SearchRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "query": req.query,
        "mode": req.mode.value,
        "limit": req.limit,
    }
    if req.threshold is not None:
        args["threshold"] = req.threshold
    args.update(_agent_context(x_agent_id))
    return await _tool("search", args)


@app.post("/ingest", response_model=VestigeResponse)
async def ingest(
    req: IngestRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "content": req.content,
        "node_type": req.node_type,
        "tags": req.tags,
    }
    if req.context:
        args["context"] = req.context
    args.update(_agent_context(x_agent_id))
    return await _tool("ingest", args)


@app.post("/smart_ingest", response_model=VestigeResponse)
async def smart_ingest(
    req: SmartIngestRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "content": req.content,
        "node_type": req.node_type,
        "tags": req.tags,
    }
    if req.context:
        args["context"] = req.context
    args.update(_agent_context(x_agent_id))
    return await _tool("smart_ingest", args)


@app.post("/promote", response_model=VestigeResponse)
async def promote(
    req: PromoteRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {"memory_id": req.memory_id}
    args.update(_agent_context(x_agent_id))
    return await _tool("promote_memory", args)


@app.post("/demote", response_model=VestigeResponse)
async def demote(
    req: DemoteRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {"memory_id": req.memory_id}
    args.update(_agent_context(x_agent_id))
    return await _tool("demote_memory", args)


@app.post("/memory", response_model=VestigeResponse)
async def memory(
    req: MemoryRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "action": req.action.value,
        "memory_id": req.memory_id,
    }
    args.update(_agent_context(x_agent_id))
    return await _tool("memory", args)


@app.post("/codebase", response_model=VestigeResponse)
async def codebase(
    req: CodebaseRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "content": req.content,
        "pattern_type": req.pattern_type,
        "tags": req.tags,
    }
    if req.context:
        args["context"] = req.context
    args.update(_agent_context(x_agent_id))
    return await _tool("codebase", args)


@app.post("/intention", response_model=VestigeResponse)
async def intention(
    req: IntentionRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "content": req.content,
        "tags": req.tags,
    }
    if req.trigger:
        args["trigger"] = req.trigger
    args.update(_agent_context(x_agent_id))
    return await _tool("intention", args)
