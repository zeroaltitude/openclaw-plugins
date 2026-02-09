# Architecture

## Overview

openclaw-vestige is a three-layer system that gives OpenClaw agents persistent cognitive memory:

1. **OpenClaw Plugin** (TypeScript, CommonJS) — Registers tools in the agent's tool palette
2. **FastAPI Bridge** (Python) — HTTP REST API with authentication, connects to Vestige over MCP
3. **Vestige MCP Server** (Rust) — The actual memory engine, exposed via Streamable HTTP

## Architecture (v0.2 — Decoupled)

In v0.2, the bridge no longer spawns Vestige as a subprocess. Instead, Vestige runs as an independent service (wrapped by [supergateway](https://github.com/nicholasgriffintn/supergateway) to expose Streamable HTTP), and the bridge connects to it as an MCP client over HTTP.

```
┌──────────────────┐     HTTP/JSON      ┌──────────────────────────┐
│  OpenClaw Agent   │ ──────────────────▶│  FastAPI Bridge          │
│  (plugin)         │                    │  (Python)                │
│                   │  Authorization:    │                          │
│  vestige_search   │  Bearer <token>    │  POST /search            │
│  vestige_ingest   │  X-Agent-Id: ...   │  POST /ingest            │
│  vestige_smart_.. │                    │  POST /smart_ingest      │
│  vestige_promote  │                    │  POST /promote           │
│  vestige_demote   │                    │  POST /demote            │
└──────────────────┘                    │  POST /memory            │
                                        │  POST /codebase          │
                                        │  POST /intention         │
                                        │  GET  /health            │
                                        │  GET  /readyz            │
                                        └──────────┬───────────────┘
                                                   │
                                        MCP JSON-RPC over Streamable HTTP
                                         POST http://vestige:3100/mcp
                                                   │
                                        ┌──────────▼───────────────┐
                                        │  supergateway            │
                                        │  (Node.js, port 3100)    │
                                        │                          │
                                        │  Wraps vestige-mcp stdio │
                                        │  → Streamable HTTP       │
                                        └──────────┬───────────────┘
                                                   │
                                            stdio (NDJSON)
                                                   │
                                        ┌──────────▼───────────────┐
                                        │  vestige-mcp             │
                                        │  (Rust binary, unmodified)│
                                        │                          │
                                        │  SQLite + Nomic Embed    │
                                        │  FSRS-6 + dual-strength  │
                                        └──────────────────────────┘
```

### Why Decoupled?

- **Independent lifecycle**: Vestige can be restarted/upgraded without restarting the bridge
- **Direct MCP access**: Claude Code can connect to Vestige directly via `claude mcp add vestige --url http://localhost:3100/mcp`
- **Simpler bridge**: No subprocess management, lifecycle locks, stderr draining
- **Better observability**: Each component has its own health checks and logs
- **Flexible deployment**: Can be run as Docker Compose services, k8s sidecar containers, or separate pods

## Data Flow

### Write Path (Ingest)

```
Agent → vestige_smart_ingest("User prefers TypeScript")
  → Plugin: POST /smart_ingest {content: "...", node_type: "fact"}
    → Bridge: POST http://vestige:3100/mcp
        {"jsonrpc":"2.0","id":3,"method":"tools/call",
         "params":{"name":"smart_ingest","arguments":{...}}}
      → supergateway → vestige-mcp (stdio)
        → Prediction Error Gating
          → SIMILARITY CHECK against existing memories
          → Decision: CREATE / UPDATE / REINFORCE / SUPERSEDE
          → Embed content with Nomic Embed Text v1.5
          → Store in SQLite with FSRS-6 scheduling
      ← MCP result { content: [{ type: "text", text: "..." }] }
    ← HTTP 200 {success: true, data: { content: [...] }}
  ← Tool result (extracted text content)
```

### Read Path (Search)

```
Agent → vestige_search("TypeScript preferences")
  → Plugin: POST /search {query: "...", mode: "hybrid"}
    → Bridge: POST http://vestige:3100/mcp
        {"jsonrpc":"2.0","id":5,"method":"tools/call",
         "params":{"name":"search","arguments":{...}}}
      → supergateway → vestige-mcp (stdio)
        → Hybrid Search
          → Keyword search (BM25-style)
          → Semantic search (embedding cosine similarity)
          → Combine + rank by relevance × retention_strength
          → Testing Effect: strengthen retrieved memories
      ← MCP result with ranked memories
    ← HTTP 200 {success: true, data: { content: [...] }}
  ← Tool result (extracted text content)
```

## MCP Protocol Details

The bridge speaks MCP JSON-RPC 2.0 over Streamable HTTP to the supergateway endpoint.

### Transport Modes

| Mode | URL Pattern | How It Works |
|------|-------------|-------------|
| `streamable_http` (default) | `http://host:3100/mcp` | POST JSON-RPC to `/mcp`, responses as JSON |
| `sse` | `http://host:3100/sse` | GET `/sse` for events, POST `/message` for requests |

Configured via `VESTIGE_TRANSPORT` environment variable.

### Initialize Handshake

```json
→ POST /mcp
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"openclaw-vestige-bridge","version":"0.2.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"vestige-mcp","version":"1.1.2"}}}

→ POST /mcp
  {"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
← 200 OK (or 202 Accepted)
```

### Tool Discovery

After initialization, the bridge calls `tools/list` to discover available tool names:
```json
→ POST /mcp
  {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search",...},{"name":"smart_ingest",...}]}}
```
Discovered tool names are logged at startup so operators can verify they match the bridge endpoints.

### Tool Call

```json
→ POST /mcp
  {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"preferences","mode":"hybrid","limit":10}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Found 3 memories:\n1. ..."}]}}
```

The bridge extracts the `content` array from the result and passes it to the HTTP response.
The plugin then extracts text content from the array for the agent.

## Deployment Patterns

### Docker Compose (Local Dev)

Two services connected via Docker networking:

```yaml
services:
  vestige:    # supergateway + vestige-mcp, port 3100
  bridge:     # FastAPI, port 8000, connects to vestige:3100
```

### Kubernetes (Production)

Sidecar pattern — both containers in the same pod:

```
┌─── Pod ─────────────────────────────────────────┐
│                                                   │
│  ┌─────────────┐     localhost:3100  ┌──────────┐│
│  │   bridge     │ ─────────────────▶ │ vestige  ││
│  │  (port 8000) │                    │(port 3100)││
│  └─────────────┘                    └──────────┘│
│         │                                  │      │
│         ▼                                  ▼      │
│    Service:8000                        /data PVC  │
│    (external)                        (shared vol) │
└───────────────────────────────────────────────────┘
```

- Bridge is exposed via Service/Ingress on port 8000
- Vestige is only accessible on localhost:3100 within the pod
- Shared PVC for SQLite data and embedding model cache

## Agent Context

The `X-Agent-Id` header is included as a separate `agent_id` field in MCP tool arguments.
If the request also provides a user `context`, both are preserved — agent_id is prepended
to the context string rather than overwriting it.

## Memory Science

Vestige implements several cognitive science principles:

- **FSRS-6**: Free Spaced Repetition Scheduler — memories decay over time but strengthen with use
- **Dual-Strength Memory** (Bjork & Bjork, 1992): Storage strength (encoding) vs retrieval strength (accessibility)
- **Prediction Error Gating**: New info is compared to existing memories; high similarity → reinforce, moderate → update, low → create new
- **Testing Effect**: Searching for memories strengthens them (retrieval practice)
- **Spreading Activation**: Related memories are primed when nearby memories are accessed

## Security Model

- **Bearer token auth**: Required for all endpoints except `/health` and `/readyz`. Auth cannot be silently disabled — open access requires explicit `VESTIGE_ALLOW_ANONYMOUS=true`
- **Timing-safe comparison**: Token verification uses `secrets.compare_digest` to prevent timing attacks
- **Agent identity**: `X-Agent-Id` header tracks which agent made each request
- **Vestige has no auth**: The bridge is the auth layer. Vestige is only accessible within the pod/network
- **Internal network**: Deployed behind internal ALB — no public access
- **Non-root container**: Both containers run as UID/GID 1000 with all capabilities dropped
- **Helm secret validation**: Deployment fails if auth token is empty without `existingSecret`

## Persistence

- **SQLite**: Single-file database in `/data/vestige.db`
- **Embedding model**: Nomic Embed Text v1.5 (~130MB), cached in `/data/.cache/vestige/fastembed` (on PVC)
- **PVC**: 5Gi EBS volume in k8s (gp3 storage class) — stores both database and embedding cache, shared between vestige and bridge containers
- **Backups**: SQLite file can be copied for backup; vestige-restore CLI available

## Scaling Considerations

- **Single-writer**: SQLite limits us to one replica. This is fine for the expected load (tens of agents, hundreds of req/day)
- **Future**: If needed, could migrate to PostgreSQL + pgvector and scale horizontally
- **Memory**: Vestige sidecar needs ~256-512Mi RAM; bridge needs ~128-256Mi
- **CPU**: Embedding computation is the hot path (in Vestige container); bridge is lightweight
- **First boot**: Downloads Nomic Embed model (~130MB) on first request. Startup probe gives 5 minutes for this. Subsequent boots use cache on PVC.
