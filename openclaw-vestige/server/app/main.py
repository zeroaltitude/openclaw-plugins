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
    MEMORY_ACTION_TO_ENGINE,
    MemoryRequest,
    PredictRequest,
    PromoteRequest,
    SearchRequest,
    SessionContextRequest,
    SmartIngestRequest,
    TRIGGER_FIELD_TO_ENGINE,
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

def _agent_args(agent_id: str | None) -> dict[str, Any]:
    """Agent-attribution arguments safe to add to any tool call.

    Only ``agent_id`` is sent. No engine tool declares an ``agent_id`` field and
    none of the engine's argument structs use ``deny_unknown_fields``, so this is
    inert at the engine today — it is carried for attribution in MCP-level request
    logs and for forward compatibility.

    This helper deliberately does **not** emit a ``context`` key. It used to, as a
    string, which was a silent no-op for the tools that have no ``context`` field
    and an outright failure for the ones whose ``context`` is an object:
    ``/intention`` returned ``invalid type: string "agent:tank", expected struct
    ContextSpec``, and ``/predict`` had its structured context overwritten
    (openclaw-vestige-7wh). Object-context tools use :func:`_with_agent_topic`;
    tools that accept free-form provenance use :func:`_provenance` as ``source``.
    """
    return {"agent_id": agent_id} if agent_id else {}


def _provenance(agent_id: str | None, existing_context: str | None = None) -> str | None:
    """Collapse agent identity and a caller-supplied context into one string.

    Suitable for the engine's free-form ``source`` field (smart_ingest).
    """
    parts = [p for p in (f"agent:{agent_id}" if agent_id else None, existing_context) if p]
    return " | ".join(parts) if parts else None


def _with_agent_topic(
    ctx: dict[str, Any], agent_id: str | None, key: str = "topics"
) -> dict[str, Any]:
    """Record agent identity inside an *object*-typed engine context.

    The engine's context structs carry no identity field, so agent identity rides
    along as the first topic — the same approach /session_context already used.
    """
    if agent_id:
        topics = ctx.setdefault(key, [])
        if isinstance(topics, list):
            topics.insert(0, f"agent:{agent_id}")
    return ctx


# ── Body truncation ──────────────────────────────────────────────────────────

#: Fields whose string values are candidates for truncation on /search results.
_BODY_FIELDS = ("body", "content", "text", "merged_body")


def _truncate_result_bodies(result: Any, max_chars: int) -> Any:
    """Walk a search result payload and truncate large string fields.

    For each result item, any field in ``_BODY_FIELDS`` whose string length
    exceeds ``max_chars`` is handled as follows:
      - ``body_length`` is set to the original character count
      - the field value is replaced with the first ``max_chars`` chars
      - ``truncated_body`` is set to the same truncated value (explicit
        signal for callers that want to key on it)

    Handles two common MCP result shapes:
    - ``{"results": [{...}, ...]}``  — processes items in ``results`` list
    - ``[{...}, ...]``               — bare list, processes each item

    Leaves everything else untouched.
    """
    candidates: list[dict[str, Any]]

    if isinstance(result, list):
        candidates = [item for item in result if isinstance(item, dict)]
    elif isinstance(result, dict):
        top_results = result.get("results")
        if isinstance(top_results, list):
            candidates = [item for item in top_results if isinstance(item, dict)]
        elif "id" in result:
            # Single memory dict at top level
            candidates = [result]
        else:
            return result
    else:
        return result

    for item in candidates:
        for field in _BODY_FIELDS:
            value = item.get(field)
            if isinstance(value, str) and len(value) > max_chars:
                truncated = value[:max_chars]
                item["body_length"] = len(value)
                item[field] = truncated
                item["truncated_body"] = truncated

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
    # The engine's search tool has no `mode` (always hybrid) and names the score
    # floor `min_similarity` — but its SearchArgs struct is
    # #[serde(rename_all = "camelCase")] with no alias, so only `minSimilarity`
    # actually deserializes. `threshold` was silently dropped (openclaw-vestige-7wh).
    args: dict[str, Any] = {
        "query": req.query,
        "limit": req.limit,
    }
    if req.threshold is not None:
        args["minSimilarity"] = req.threshold
    args.update(_agent_args(x_agent_id))
    response = await _tool("search", args)
    # Apply body truncation when requested (default 8000 chars)
    max_chars = req.truncate_body_chars
    if response.success and response.data is not None and max_chars and max_chars > 0:
        response.data = _truncate_result_bodies(response.data, max_chars)
    return response


@app.post("/ingest", response_model=VestigeResponse)
async def ingest(
    req: IngestRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # The engine has no `context` field on smart_ingest; `source` is its free-form
    # provenance slot, so agent identity + caller context go there.
    args: dict[str, Any] = {
        "content": req.content,
        "node_type": req.node_type,
        "tags": req.tags,
    }
    source = _provenance(x_agent_id, req.context)
    if source:
        args["source"] = source
    args.update(_agent_args(x_agent_id))
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
    source = _provenance(x_agent_id, req.context)
    if source:
        args["source"] = source
    args.update(_agent_args(x_agent_id))
    return await _tool("smart_ingest", args)


@app.post("/promote", response_model=VestigeResponse)
async def promote(
    req: PromoteRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # v2.0: promote_memory deprecated → use memory tool with action='promote'
    args: dict[str, Any] = {"action": "promote", "id": req.memory_id}
    args.update(_agent_args(x_agent_id))
    return await _tool("memory", args)


@app.post("/demote", response_model=VestigeResponse)
async def demote(
    req: DemoteRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # v2.0: demote_memory deprecated → use memory tool with action='demote'
    args: dict[str, Any] = {"action": "demote", "id": req.memory_id}
    args.update(_agent_args(x_agent_id))
    return await _tool("memory", args)


@app.post("/memory", response_model=VestigeResponse)
async def memory(
    req: MemoryRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # The engine's memory tool requires "id", not "memory_id", and knows
    # "state" rather than the bridge's legacy "check_state".
    args: dict[str, Any] = {
        "action": MEMORY_ACTION_TO_ENGINE.get(req.action, req.action.value),
        "id": req.memory_id,
    }
    args.update(_agent_args(x_agent_id))
    return await _tool("memory", args)


@app.post("/codebase", response_model=VestigeResponse)
async def codebase(
    req: CodebaseRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # The engine's codebase tool is action-dispatched and requires `action`; it has
    # no `content`/`pattern_type`/`tags` fields at all, so the old argument shape
    # failed with `missing field \`action\`` on every call (openclaw-vestige-7wh).
    args: dict[str, Any] = {"action": req.action.value}
    for field in ("name", "description", "decision", "rationale", "codebase", "limit"):
        value = getattr(req, field)
        if value is not None:
            args[field] = value
    if req.alternatives:
        args["alternatives"] = req.alternatives
    if req.files:
        args["files"] = req.files
    args.update(_agent_args(x_agent_id))
    return await _tool("codebase", args)


@app.post("/intention", response_model=VestigeResponse)
async def intention(
    req: IntentionRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # The engine's intention tool is action-dispatched: it requires `action`, names
    # the body `description` (not `content`), takes `trigger` as an object (not a
    # string), and has no `tags`. Its nested TriggerSpec is
    # #[serde(rename_all = "camelCase")] with no aliases, so multi-word trigger
    # fields must be sent camelCase or they are silently dropped. The old shape
    # failed on every call (openclaw-vestige-7wh).
    args: dict[str, Any] = {"action": req.action.value}
    for field in (
        "description",
        "priority",
        "deadline",
        "id",
        "status",
        "snooze_minutes",
        "include_snoozed",
        "filter_status",
        "limit",
    ):
        value = getattr(req, field)
        if value is not None:
            args[field] = value
    if req.trigger is not None:
        args["trigger"] = {
            TRIGGER_FIELD_TO_ENGINE.get(k, k): v
            for k, v in req.trigger.model_dump(exclude_none=True).items()
        }
    ctx = req.context.model_dump(exclude_none=True) if req.context else {}
    ctx = _with_agent_topic(ctx, x_agent_id)
    if ctx:
        args["context"] = ctx
    args.update(_agent_args(x_agent_id))
    return await _tool("intention", args)


# ── v2.0 Endpoints ────────────────────────────────────────────────────────────

@app.post("/dream", response_model=VestigeResponse)
async def dream(
    req: DreamRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {"memory_count": req.memory_count}
    args.update(_agent_args(x_agent_id))
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
    ctx = req.context.model_dump(exclude_none=True) if req.context else {}
    ctx = _with_agent_topic(ctx, x_agent_id)
    if ctx:
        args["context"] = ctx
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
    args.update(_agent_args(x_agent_id))
    return await _tool("explore_connections", args)


@app.post("/predict", response_model=VestigeResponse)
async def predict(
    req: PredictRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # predict's `context` is an object (current_file / current_topics / codebase).
    # The old code built it and then had it overwritten by _agent_context's string
    # `context`, so every call with an X-Agent-Id header lost its context entirely
    # (openclaw-vestige-7wh). Agent identity rides along as a topic instead.
    args: dict[str, Any] = {}
    ctx = req.context.model_dump(exclude_none=True) if req.context else {}
    ctx = _with_agent_topic(ctx, x_agent_id, key="current_topics")
    if ctx:
        args["context"] = ctx
    args.update(_agent_args(x_agent_id))
    return await _tool("predict", args)


@app.post("/importance_score", response_model=VestigeResponse)
async def importance_score(
    req: ImportanceScoreRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # ImportanceArgs is #[serde(rename_all = "camelCase")] with no alias, so
    # `context_topics` never deserialized — only `contextTopics` does
    # (openclaw-vestige-7wh).
    args: dict[str, Any] = {"content": req.content}
    if req.context_topics:
        args["contextTopics"] = req.context_topics
    if req.project:
        args["project"] = req.project
    args.update(_agent_args(x_agent_id))
    return await _tool("importance_score", args)


@app.post("/consolidate", response_model=VestigeResponse)
async def consolidate(
    req: ConsolidateRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {}
    args.update(_agent_args(x_agent_id))
    return await _tool("consolidate", args)


@app.post("/backup", response_model=VestigeResponse)
async def backup(
    req: BackupRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {}
    args.update(_agent_args(x_agent_id))
    return await _tool("backup", args)
