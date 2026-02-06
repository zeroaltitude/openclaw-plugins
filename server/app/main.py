"""FastAPI HTTP bridge for vestige-mcp.

Spawns the vestige-mcp binary as a subprocess and translates incoming HTTP
requests into MCP JSON-RPC tool calls over stdin/stdout.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException
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
    # Log discovered tool names so operators can verify they match endpoints
    tool_names = mcp.tool_names
    if tool_names:
        logger.info("Vestige MCP tools available: %s", ", ".join(tool_names))
    else:
        logger.warning("No tools discovered from Vestige MCP — endpoints may not work")
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

def _agent_context(agent_id: str | None, existing_context: str | None = None) -> dict[str, Any]:
    """Build optional agent context dict.

    Instead of overwriting the user's context with agent_id, we include
    agent_id as a separate field and preserve the original context.
    """
    result: dict[str, Any] = {}
    if existing_context:
        result["context"] = existing_context
    if agent_id:
        result["agent_id"] = agent_id
        # If there's already a context, prepend agent identity
        if "context" in result:
            result["context"] = f"agent:{agent_id} | {result['context']}"
        else:
            result["context"] = f"agent:{agent_id}"
    return result


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
    is_alive = mcp.alive
    response = HealthResponse(
        status="healthy" if is_alive else "unhealthy",
        vestige_process=is_alive,
        uptime_seconds=round(mcp.uptime, 1),
    )
    if not is_alive:
        raise HTTPException(status_code=503, detail=response.model_dump())
    return response


@app.get("/readyz")
async def readyz():
    """Readiness probe endpoint — returns 200 only when the MCP process is alive."""
    if not mcp.alive:
        raise HTTPException(status_code=503, detail="vestige-mcp not ready")
    return {"ready": True}


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
    args.update(_agent_context(x_agent_id, req.context))
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
    args.update(_agent_context(x_agent_id, req.context))
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
    args.update(_agent_context(x_agent_id, req.context))
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
