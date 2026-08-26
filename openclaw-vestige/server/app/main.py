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
    MEMORY_ACTION_ALIASES,
    BackupRequest,
    CodebaseRequest,
    ConsolidateRequest,
    DemoteRequest,
    DreamRequest,
    ExploreConnectionsRequest,
    HealthResponse,
    ImportanceScoreRequest,
    IngestRequest,
    IntentionAction,
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

# ── Engine argument contract ─────────────────────────────────────────────────
#
# The engine is the contract: every argument this bridge sends must be a
# property the target tool's JSON schema declares. Two things make that
# non-obvious, and both have bitten us (openclaw-vestige-ow6):
#
# 1. The bridge's REST field names are not the engine's argument names
#    (``memory_id`` vs ``id``). Translate explicitly, per endpoint.
#
# 2. Some tools publish snake_case properties but deserialize with
#    ``#[serde(rename_all = "camelCase")]`` and no snake_case alias, so the
#    documented name is silently dropped on the wire. ``_WIRE_ALIASES`` maps
#    the published schema name to the name the deserializer actually accepts.
#    This is an engine-side defect (tracked separately); when the engine adds
#    ``#[serde(alias = ...)]`` for these, the entry can be deleted.
#    Verified against vestige @ 3bd2b71, crates/vestige-mcp/src/tools/.
_WIRE_ALIASES: dict[str, dict[str, str]] = {
    "search": {
        "min_retention": "minRetention",
        "min_similarity": "minSimilarity",
        "context_topics": "contextTopics",
    },
    "importance_score": {"context_topics": "contextTopics"},
}

#: Same defect, one level down, inside the ``intention`` tool's nested objects.
_INTENTION_TRIGGER_ALIASES = {"in_minutes": "inMinutes", "file_pattern": "filePattern"}
_INTENTION_CONTEXT_ALIASES = {"current_time": "currentTime"}


def _rename(args: dict[str, Any], aliases: dict[str, str]) -> dict[str, Any]:
    """Return ``args`` with any key in ``aliases`` renamed to its wire name."""
    return {aliases.get(key, key): value for key, value in args.items()}


def _agent_topics(topics: list[str] | None, agent_id: str | None) -> list[str]:
    """Prepend the calling agent's identity to a context-topics list.

    Agent scoping is not a first-class engine concept — no tool schema has an
    ``agent_id`` property (see docs/DESIGN-PER-AGENT-MEMORY.md, still a design).
    Where a tool accepts free-form topics we carry identity there; where it does
    not, we send nothing rather than an argument the engine will discard.
    """
    result = list(topics or [])
    if agent_id:
        result.insert(0, f"agent:{agent_id}")
    return result


def _agent_source(context: str | None, agent_id: str | None) -> str | None:
    """Build the ``source`` argument for ingest-family tools.

    ``smart_ingest`` has no ``context`` property; ``source`` ("Source or
    reference for this knowledge") is where provenance belongs.
    """
    parts = [p for p in (f"agent:{agent_id}" if agent_id else None, context) if p]
    return " | ".join(parts) or None


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
    arguments = _rename(arguments, _WIRE_ALIASES.get(name, {}))
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
    # req.mode has no engine counterpart — the unified `search` tool is always
    # hybrid. It stays on the REST model for compatibility but is not forwarded.
    args: dict[str, Any] = {
        "query": req.query,
        "limit": req.limit,
    }
    if req.threshold is not None:
        args["min_similarity"] = req.threshold
    if topics := _agent_topics(None, x_agent_id):
        args["context_topics"] = topics
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
    args: dict[str, Any] = {
        "content": req.content,
        "node_type": req.node_type,
        "tags": req.tags,
    }
    if source := _agent_source(req.context, x_agent_id):
        args["source"] = source
    # The engine dropped `ingest` from tools/list in v1.7; it survives only as a
    # deprecated redirect to the identical smart_ingest code path. Call the
    # advertised tool directly.
    return await _tool("smart_ingest", args)


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
    if source := _agent_source(req.context, x_agent_id):
        args["source"] = source
    return await _tool("smart_ingest", args)


# The `memory` tool schema declares no topic-like or provenance property, so
# the calling agent's identity has nowhere to go on these three endpoints.
# We send nothing rather than an argument the engine would silently discard.

@app.post("/promote", response_model=VestigeResponse)
async def promote(req: PromoteRequest):
    # v2.0: promote_memory deprecated → use memory tool with action='promote'
    return await _tool("memory", {"action": "promote", "id": req.memory_id})


@app.post("/demote", response_model=VestigeResponse)
async def demote(req: DemoteRequest):
    # v2.0: demote_memory deprecated → use memory tool with action='demote'
    return await _tool("memory", {"action": "demote", "id": req.memory_id})


@app.post("/memory", response_model=VestigeResponse)
async def memory(req: MemoryRequest):
    action = MEMORY_ACTION_ALIASES.get(req.action.value, req.action.value)
    args: dict[str, Any] = {"action": action, "id": req.memory_id}
    if req.reason is not None:
        args["reason"] = req.reason
    if req.content is not None:
        args["content"] = req.content
    return await _tool("memory", args)


@app.post("/codebase", response_model=VestigeResponse)
async def codebase(req: CodebaseRequest):
    # Pass-through of the engine's `codebase` schema; omit unset optionals so
    # each action only carries the fields it actually uses.
    args: dict[str, Any] = {"action": req.action.value}
    for field in ("name", "description", "decision", "rationale", "codebase"):
        if (value := getattr(req, field)) is not None:
            args[field] = value
    for field in ("alternatives", "files"):
        if value := getattr(req, field):
            args[field] = value
    if req.action.value == "get_context":
        args["limit"] = req.limit
    return await _tool("codebase", args)


@app.post("/intention", response_model=VestigeResponse)
async def intention(
    req: IntentionRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # Pass-through of the engine's `intention` schema.
    args: dict[str, Any] = {"action": req.action.value}
    for field in ("description", "deadline", "id", "snooze_minutes", "include_snoozed", "limit"):
        if (value := getattr(req, field)) is not None:
            args[field] = value
    for field in ("priority", "status", "filter_status"):
        if (value := getattr(req, field)) is not None:
            args[field] = value.value
    if req.trigger is not None:
        trigger = req.trigger.model_dump(exclude_none=True, mode="json")
        args["trigger"] = _rename(trigger, _INTENTION_TRIGGER_ALIASES)

    # Only the `check` action reads `context`, and its topics list is the one
    # place this tool can carry agent identity.
    if req.action is IntentionAction.check:
        context = req.context.model_dump(exclude_none=True) if req.context else {}
        if topics := _agent_topics(context.get("topics"), x_agent_id):
            context["topics"] = topics
        if context:
            args["context"] = _rename(context, _INTENTION_CONTEXT_ALIASES)

    return await _tool("intention", args)


# ── v2.0 Endpoints ────────────────────────────────────────────────────────────

@app.post("/dream", response_model=VestigeResponse)
async def dream(req: DreamRequest):
    # `dream` declares only memory_count — no place for agent identity.
    return await _tool("dream", {"memory_count": req.memory_count})


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
async def explore_connections(req: ExploreConnectionsRequest):
    # `explore_connections` declares no topic-like property.
    args: dict[str, Any] = {
        "action": req.action.value,
        "from": req.from_id,
        "limit": req.limit,
    }
    if req.to_id:
        args["to"] = req.to_id
    return await _tool("explore_connections", args)


@app.post("/predict", response_model=VestigeResponse)
async def predict(
    req: PredictRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    # `context` is an object here. Merge agent identity into current_topics —
    # assigning a string to `context` (the old behaviour) discarded the
    # caller's whole prediction context.
    context = req.context.model_dump(exclude_none=True) if req.context else {}
    if topics := _agent_topics(context.get("current_topics"), x_agent_id):
        context["current_topics"] = topics
    return await _tool("predict", {"context": context} if context else {})


@app.post("/importance_score", response_model=VestigeResponse)
async def importance_score(
    req: ImportanceScoreRequest,
    x_agent_id: str | None = Header(None, alias="X-Agent-Id"),
):
    args: dict[str, Any] = {"content": req.content}
    if topics := _agent_topics(req.context_topics, x_agent_id):
        args["context_topics"] = topics
    if req.project:
        args["project"] = req.project
    return await _tool("importance_score", args)


@app.post("/consolidate", response_model=VestigeResponse)
async def consolidate(req: ConsolidateRequest):
    return await _tool("consolidate", {})


@app.post("/backup", response_model=VestigeResponse)
async def backup(req: BackupRequest):
    return await _tool("backup", {})
