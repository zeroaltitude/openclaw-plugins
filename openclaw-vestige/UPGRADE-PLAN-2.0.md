# Vestige 2.0 Upgrade Plan

**Date:** 2026-02-27
**Author:** Tank
**Status:** Draft — awaiting Eddie's approval

---

## 1. Fork Divergence Analysis

**Our fork:** `zeroaltitude/vestige`
**Upstream:** `samvallad33/vestige`

### Current state:
- `zeroaltitude:main` is **fully up-to-date** with `samvallad33:main` — zero divergence, no conflicts.
- `zeroaltitude:feat/http-mcp` has **2 commits ahead** of upstream main (6 files changed):
  - `feat: add native HTTP Streamable transport for MCP` — adds `crates/vestige-mcp/src/protocol/http.rs` with axum-based Streamable HTTP transport
  - `fix: correct MCP protocol version to 2025-03-26` — protocol version fix

### Conflict risk: **LOW**
Our HTTP transport work is additive (new files + feature flag in Cargo.toml). Upstream 2.0 shipped on Feb 22 and our `main` already includes it. The `feat/http-mcp` branch should rebase cleanly onto the 2.0 code since it touches `crates/vestige-mcp/src/protocol/` (new file) and `Cargo.toml` (additive feature).

**Action:** Rebase `feat/http-mcp` onto current `main` (which already has 2.0). If there are Cargo.toml conflicts from upstream dependency changes, they'll be trivial to resolve.

### GLIBC issue
Current installed binary fails with `GLIBC_2.38 not found` on our WSL2 host (has older glibc). Options:
- Build from source on the target host
- Use the Docker deployment
- Run on the production server (vestige.bighatbio.me) which likely has newer glibc

---

## 2. What 2.0 Adds (upstream)

From the v2.0.0 "Cognitive Leap" release (Feb 22, 2026):

| Feature | MCP Tool | Bridge Endpoint Needed | Priority |
|---------|----------|----------------------|----------|
| Dream (memory consolidation/replay) | `dream` | Yes — new | **P0** |
| Session context (one-call init) | `session_context` | Yes — new | **P0** |
| Explore (connection discovery) | `explore` | Yes — new | P1 |
| Consolidate (maintenance/GC) | `consolidate` | Yes — new | P1 |
| Predict (retention predictions) | `predict` | Yes — new | P2 |
| Importance (scoring) | `importance` | Yes — new | P2 |
| HyDE query expansion | Automatic (improves `search`) | No — transparent | **P0** (free win) |
| 3D Dashboard | REST + WebSocket | Optional | P3 |

**Total new MCP tools in 2.0:** 21 tools (up from ~12 in v1.x)

---

## 3. Current Architecture

```
Agents (OpenClaw plugin)
    ↓ HTTP + Bearer token
FastAPI Bridge (server/app/main.py)
    ↓ MCP Streamable HTTP
supergateway → vestige-mcp (stdio)
    ↓
vestige.db (SQLite + embeddings)
```

**Bridge server:** 9 endpoints (search, ingest, smart_ingest, promote, demote, memory, codebase, intention + health)
**OpenClaw plugin:** Exposes 5 tools (search, ingest, smart_ingest, promote, demote)
**Gap:** 3 bridge endpoints not wired to plugin (memory, codebase, intention) + all 2.0 features

---

## 4. Upgrade Plan

### Phase 1: Upgrade vestige-mcp binary to 2.0 (~1 hour)

1. Pull latest `main` (already has 2.0) in `~/projects/vestige`
2. Rebase `feat/http-mcp` onto main, resolve any conflicts
3. Build from source: `cargo build --release -p vestige-mcp`
4. Deploy binary to server, swap in place
5. Verify: health check + existing search/ingest still works
6. **Bonus:** HyDE query expansion activates automatically — search quality improves with zero code changes

### Phase 2: New bridge endpoints (~half day)

Add request models + endpoints for 2.0 tools. The pattern is identical for each — the `_tool()` helper is tool-agnostic:

```python
# Example: dream endpoint
class DreamRequest(BaseModel):
    duration: int = Field(60, description="Dream duration in seconds")

@app.post("/dream", response_model=VestigeResponse)
async def dream(req: DreamRequest, x_agent_id: str | None = Header(None, alias="X-Agent-Id")):
    args = {"duration": req.duration}
    args.update(_agent_context(x_agent_id))
    return await _tool("dream", args)
```

New endpoints to add:
- `POST /dream` — trigger memory consolidation
- `POST /session_context` — one-call session init (replaces 5 separate calls)
- `POST /explore` — discover connections between memories
- `POST /consolidate` — maintenance/garbage collection
- `POST /predict` — retention predictions for a memory
- `POST /importance` — importance scoring

**Note:** Need to verify exact MCP tool signatures from the 2.0 binary to get argument schemas right.

### Phase 3: OpenClaw plugin tool definitions (~half day)

Add tool definitions to `openclaw-plugin/` for:
- **Existing but unwired:** `vestige_memory`, `vestige_codebase`, `vestige_intention`
- **New 2.0:** `vestige_dream`, `vestige_session_context`, `vestige_explore`, `vestige_consolidate`, `vestige_predict`, `vestige_importance`

### Phase 4: Cron + integration (~2-3 hours)

- Set up nightly `dream` cron job for automatic memory consolidation
- Set up periodic `consolidate` for GC
- Test `session_context` as replacement for current multi-call init pattern
- Update agent system prompts to use new tools

### Phase 5: Optional — eliminate supergateway

Our `feat/http-mcp` branch adds native HTTP Streamable transport to vestige-mcp itself. Once merged:
- Run `vestige-mcp --http --port 3100` directly
- Remove the supergateway wrapper entirely
- Simpler deployment, one fewer process

---

## 5. Estimated Timeline

| Phase | Effort | Depends on |
|-------|--------|-----------|
| Phase 1: Binary upgrade | 1 hour | Nothing |
| Phase 2: Bridge endpoints | 4 hours | Phase 1 |
| Phase 3: Plugin tools | 4 hours | Phase 2 |
| Phase 4: Cron + integration | 3 hours | Phase 3 |
| Phase 5: Kill supergateway | 2 hours | Phase 1 |
| **Total** | **~2 days** | |

Phases 2-3 can be parallelized if Telemachus handles plugin wiring while I do bridge endpoints.

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| GLIBC incompatibility on build host | Medium | Build on production server or use Docker |
| Database migration needed for 2.0 | Low | Vestige handles migrations internally; backup db first |
| feat/http-mcp rebase conflicts | Low | Only 2 commits, additive changes |
| MCP tool signature changes in 2.0 | Medium | Verify tool schemas before writing bridge models |

---

## 7. Parallel Work (Telemachus)

Telemachus is independently wiring up the 3 existing bridge endpoints (`memory`, `codebase`, `intention`) that are already live but not exposed as agent tools. This is unblocked — those endpoints work today on the current v1.x binary.

---

## 8. Open Questions

1. **Dashboard:** Do we want the 3D dashboard exposed? Runs on port 3927, would need Caddy routing. Cool but not critical.
2. **Dream schedule:** Nightly at low-traffic hours? Or on-demand only initially?
3. **Session context token budget:** The `session_context` tool accepts a token budget — what's our default? (Suggest 2000 tokens)
