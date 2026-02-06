# Architecture

## Overview

openclaw-vestige is a three-layer system that gives OpenClaw agents persistent cognitive memory:

1. **OpenClaw Plugin** (TypeScript, CommonJS) — Registers tools in the agent's tool palette
2. **FastAPI Bridge** (Python) — HTTP-to-MCP protocol translation
3. **Vestige MCP Server** (Rust) — The actual memory engine

## Why This Architecture?

Vestige speaks **MCP (Model Context Protocol)** over stdio — it's designed to be a subprocess of Claude Desktop or Claude Code. We can't speak MCP over HTTP directly, so we need a bridge.

The bridge is intentionally thin: it adds authentication, agent identity tracking, and HTTP transport while leaving all memory logic to Vestige.

## Data Flow

### Write Path (Ingest)

```
Agent → vestige_smart_ingest("User prefers TypeScript")
  → Plugin: POST /smart_ingest {content: "...", node_type: "fact"}
    → Bridge: MCP tools/call {name: "smart_ingest", arguments: {...}}
      → Vestige: Prediction Error Gating
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
    → Bridge: MCP tools/call {name: "search", arguments: {...}}
      → Vestige: Hybrid Search
        → Keyword search (BM25-style)
        → Semantic search (embedding cosine similarity)
        → Combine + rank by relevance × retention_strength
        → Testing Effect: strengthen retrieved memories
      ← MCP result with ranked memories
    ← HTTP 200 {success: true, data: { content: [...] }}
  ← Tool result (extracted text content)
```

## MCP Protocol Details

The bridge speaks MCP JSON-RPC 2.0 over stdio to the vestige-mcp subprocess.

### Transport Framing

The stdio transport uses **NDJSON (newline-delimited JSON)** — each message is a single
JSON object terminated by `\n`. This matches the Vestige implementation which is built
on the `rmcp` Rust crate. NDJSON is the most common framing for MCP stdio transports
(as opposed to LSP-style `Content-Length` headers used by some other implementations).

### Initialize Handshake

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"openclaw-vestige-bridge","version":"0.1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"vestige-mcp","version":"1.1.2"}}}
→ {"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
```

### Tool Discovery

After initialization, the bridge calls `tools/list` to discover available tool names:
```json
→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search",...},{"name":"smart_ingest",...}]}}
```
Discovered tool names are logged at startup so operators can verify they match the bridge endpoints.

### Tool Call

```json
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"preferences","mode":"hybrid","limit":10}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Found 3 memories:\n1. ..."}]}}
```

The bridge extracts the `content` array from the result and passes it to the HTTP response.
The plugin then extracts text content from the array for the agent.

## Process Management

### Lifecycle

- The MCP subprocess is spawned at FastAPI startup (lifespan context)
- A **lifecycle lock** (`asyncio.Lock`) prevents concurrent `ensure_alive()` calls from spawning duplicate processes
- A background **stderr drain task** continuously reads the subprocess stderr to prevent pipe buffer deadlock
- On crash, `ensure_alive()` automatically restarts the subprocess with full re-initialization

### Agent Context

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
- **Internal network**: Deployed behind internal ALB — no public access
- **Non-root container**: Runs as UID/GID 1000 with all capabilities dropped
- **Helm secret validation**: Deployment fails if auth token is empty without `existingSecret`

## Persistence

- **SQLite**: Single-file database in `/data/vestige.db`
- **Embedding model**: Nomic Embed Text v1.5 (~130MB), cached in `/data/.cache/vestige/fastembed` (on PVC)
- **PVC**: 5Gi EBS volume in k8s (gp3 storage class) — stores both database and embedding cache
- **Backups**: SQLite file can be copied for backup; vestige-restore CLI available

## Scaling Considerations

- **Single-writer**: SQLite limits us to one replica. This is fine for the expected load (tens of agents, hundreds of req/day)
- **Future**: If needed, could migrate to PostgreSQL + pgvector and scale horizontally
- **Memory**: Vestige + embeddings need ~256-512Mi RAM
- **CPU**: Embedding computation is the hot path; 250-500m CPU is sufficient
- **First boot**: Downloads Nomic Embed model (~130MB) on first request. Startup probe gives 5 minutes for this. Subsequent boots use cache on PVC.
