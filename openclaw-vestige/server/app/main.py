"""FastAPI HTTP bridge for vestige-mcp.

Connects to an external Vestige MCP server (via Streamable HTTP or SSE) and
translates incoming HTTP requests into MCP JSON-RPC tool calls.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException

from .auth import BearerAuthMiddleware
from .mcp_client import MCPClient, MCPError, MCPToolError
from .models import (
    BackupRequest,
    CodebaseRequest,
    ConsolidateRequest,
    DemoteRequest,
    DreamRequest,
    ExploreConnectionsRequest,
    HealthResponse,
    ImportanceScoreRequest,
    IngestRequest,
    IntentionRequest,
    MemoryRequest,
    PredictRequest,
    PromoteRequest,
    SearchRequest,
    SessionContextRequest,
    SmartIngestRequest,
    VestigeResponse,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("vestige.server")

# ── MCP client singleton ─────────────────────────────────────────────────────

mcp = MCPClient(
    url=os.environ.get("VESTIGE_MCP_URL"),
    transport=os.environ.get("VESTIGE_TRANSPORT"),
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Connect to the external Vestige MCP server
    logger.info(
        "Connecting to Vestige MCP at %s (transport=%s)",
        mcp.url,
        mcp.transport,
    )
    try:
        await mcp.connect()
    except Exception as exc:
        logger.error("Failed to connect to Vestige MCP: %s", exc)
        logger.error(
            "Ensure Vestige is running and VESTIGE_MCP_URL is set correctly. "
            "Bridge will retry on first request."
        )

    # Log discovered tool names so operators can verify they match endpoints
    tool_names = mcp.tool_names
    if tool_names:
        logger.info("Vestige MCP tools available: %s", ", ".join(tool_names))
    else:
        logger.warning("No tools discovered from Vestige MCP — endpoints may not work")
    yield
    await mcp.disconnect()


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="OpenClaw Vestige Bridge",
    description="HTTP bridge to the Vestige cognitive memory MCP server",
    version="0.3.1",
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
    # Optionally do a deeper health check
    if is_alive:
        is_alive = await mcp.health_check()
    response = HealthResponse(
        status="healthy" if is_alive else "unhealthy",
        vestige_connected=is_alive,
        uptime_seconds=round(mcp.uptime, 1),
    )
    if not is_alive:
        raise HTTPException(status_code=503, detail=response.model_dump())
    return response


@app.get("/readyz")
async def readyz():
    """Readiness probe endpoint — returns 200 only when connected to Vestige."""
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
    # v2.0: promote_memory deprecated → use memory tool with action='promote'
    args: dict[str, Any] = {"action": "promote", "id": req.memory_id}
    args.update(_agent_context(x_agent_id))
    return await _tool("memory", args)


@app.post("/demote", response_model=VestigeResponse)
async def demote(
    req: DemoteRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # v2.0: demote_memory deprecated → use memory tool with action='demote'
    args: dict[str, Any] = {"action": "demote", "id": req.memory_id}
    args.update(_agent_context(x_agent_id))
    return await _tool("memory", args)


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


# ── v2.0 Endpoints ────────────────────────────────────────────────────────────

@app.post("/dream", response_model=VestigeResponse)
async def dream(
    req: DreamRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {"memory_count": req.memory_count}
    args.update(_agent_context(x_agent_id))
    return await _tool("dream", args)


@app.post("/session_context", response_model=VestigeResponse)
async def session_context(
    req: SessionContextRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "queries": req.queries,
        "token_budget": req.token_budget,
        "include_status": req.include_status,
        "include_intentions": req.include_intentions,
        "include_predictions": req.include_predictions,
    }
    if req.context:
        ctx = req.context.model_dump(exclude_none=True)
        if x_agent_id:
            ctx.setdefault("topics", []).insert(0, f"agent:{x_agent_id}")
        args["context"] = ctx
    elif x_agent_id:
        args["context"] = {"topics": [f"agent:{x_agent_id}"]}
    return await _tool("session_context", args)


@app.post("/explore_connections", response_model=VestigeResponse)
async def explore_connections(
    req: ExploreConnectionsRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {
        "action": req.action.value,
        "from": req.from_id,
        "limit": req.limit,
    }
    if req.to_id:
        args["to"] = req.to_id
    args.update(_agent_context(x_agent_id))
    return await _tool("explore_connections", args)


@app.post("/predict", response_model=VestigeResponse)
async def predict(
    req: PredictRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {}
    if req.context:
        args["context"] = req.context.model_dump(exclude_none=True)
    args.update(_agent_context(x_agent_id))
    return await _tool("predict", args)


@app.post("/importance_score", response_model=VestigeResponse)
async def importance_score(
    req: ImportanceScoreRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {"content": req.content}
    if req.context_topics:
        args["context_topics"] = req.context_topics
    if req.project:
        args["project"] = req.project
    args.update(_agent_context(x_agent_id))
    return await _tool("importance_score", args)


@app.post("/consolidate", response_model=VestigeResponse)
async def consolidate(
    req: ConsolidateRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {}
    args.update(_agent_context(x_agent_id))
    return await _tool("consolidate", args)


@app.post("/backup", response_model=VestigeResponse)
async def backup(
    req: BackupRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {}
    args.update(_agent_context(x_agent_id))
    return await _tool("backup", args)
