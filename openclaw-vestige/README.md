# openclaw-vestige

Shared cognitive memory for OpenClaw agents, powered by [Vestige](https://github.com/samvallad33/vestige).

Vestige is a Rust MCP server implementing FSRS-6 spaced repetition, dual-strength memory (Bjork & Bjork), prediction error gating, and spreading activation — 130 years of memory research distilled into an AI memory system.

## Architecture

```
┌──────────────────┐     HTTP/JSON      ┌──────────────────────────┐
│  OpenClaw Agent   │ ──────────────────▶│  FastAPI Bridge Server   │
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
                                        MCP JSON-RPC (Streamable HTTP)
                                                   │
                                        ┌──────────▼───────────────┐
                                        │  vestige-mcp             │
                                        │  (Rust, native HTTP)     │
                                        │  --http --port 3100      │
                                        │                          │
                                        │  SQLite + Nomic Embed    │
                                        │  FSRS-6 + dual-strength  │
                                        └──────────────────────────┘
```

> **Recommended:** Use native HTTP transport (`vestige-mcp --http --port 3100`).
> This eliminates the supergateway/Node.js dependency entirely. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Quick Start (Local Dev)

```bash
# 1. Clone
git clone git@github.com:BigHat-Biosciences/openclaw-vestige.git
cd openclaw-vestige

# 2. Run with Docker Compose (starts Vestige + Bridge as separate services)
cd docker
VESTIGE_AUTH_TOKEN=my-secret-token docker compose up --build

# 3. Test
curl http://localhost:8000/health

curl -X POST http://localhost:8000/search \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"query": "coding preferences"}'
```

### Direct MCP Access (Claude Code)

With the Docker Compose setup running, you can also connect Claude Code directly to Vestige:

```bash
claude mcp add vestige --url http://localhost:3100/mcp
```

This bypasses the bridge (and its auth layer) — useful for local development.

## Project Structure

```
openclaw-vestige/
├── server/              # FastAPI HTTP bridge → connects to Vestige over HTTP
├── plugin/              # OpenClaw TypeScript plugin (registers agent tools)
├── docker/
│   ├── Dockerfile.vestige   # Vestige MCP with native HTTP (no supergateway)
│   ├── Dockerfile.bridge    # FastAPI bridge (Python, no Vestige binary)
│   ├── Dockerfile           # Legacy single-container (deprecated)
│   └── docker-compose.yml   # Two-service setup
├── helm/vestige/        # Kubernetes Helm chart (sidecar pattern)
└── docs/                # Architecture & deployment docs
```

## Components

### Server (`server/`)
A thin FastAPI application that:
- Connects to an external Vestige MCP server over Streamable HTTP (or SSE)
- Translates REST endpoints to MCP JSON-RPC tool calls
- Discovers available tools via `tools/list` and logs them at startup
- Provides bearer token authentication (required by default)
- Passes agent identity via `X-Agent-Id` header (preserved alongside user context)
- Reconnects automatically if the connection is lost
- Returns proper 503 status when Vestige is unreachable

### Vestige MCP (`docker/Dockerfile.vestige`)
The Vestige memory engine exposed via HTTP:
- Runs `vestige-mcp --http --port 3100` (native Streamable HTTP, no wrapper needed)
- Exposes Streamable HTTP on port 3100 at `/mcp` (POST/GET/DELETE)
- No authentication — the bridge handles auth
- Manages SQLite database and Nomic Embed model
- No Node.js or supergateway dependency

### Plugin (`plugin/`)
An OpenClaw TypeScript plugin (CommonJS) that registers five tools:
- `vestige_search` — Hybrid keyword + semantic memory search
- `vestige_ingest` — Direct memory storage
- `vestige_smart_ingest` — Intelligent ingestion with duplicate detection
- `vestige_promote` — Strengthen a memory (mark as helpful)
- `vestige_demote` — Weaken a memory (mark as wrong)

The plugin includes request timeouts (30s) and parses MCP content from responses.

### Helm Chart (`helm/vestige/`)
Production k8s deployment with sidecar pattern:
- **vestige-mcp container**: vestige-mcp with native HTTP, port 3100 (localhost only)
- **bridge container**: FastAPI, port 8000 (exposed via Service/Ingress)
- Shared PVC for data persistence (including embedding model cache)
- Internal ALB ingress with optional ACM certificate
- Separate liveness, readiness, and startup probes for each container
- Secret management for auth token (required — fails if empty)
- Container-level security hardening (drop ALL caps, no privilege escalation)

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `VESTIGE_AUTH_TOKEN` | *(required)* | Bearer token for API auth. Must be set. |
| `VESTIGE_ALLOW_ANONYMOUS` | `false` | Set to `true` to allow unauthenticated access (dev only) |
| `VESTIGE_MCP_URL` | `http://localhost:3100/mcp` | URL of the Vestige MCP endpoint |
| `VESTIGE_TRANSPORT` | `streamable_http` | Transport mode: `streamable_http` or `sse` |
| `VESTIGE_REQUEST_TIMEOUT` | `30` | Timeout in seconds for MCP requests |
| `VESTIGE_DATA_DIR` | `/data` | SQLite database directory (Vestige container) |
| `FASTEMBED_CACHE_PATH` | `/data/.cache/vestige/fastembed` | Embedding model cache (Vestige container) |
| `LOG_LEVEL` | `info` | Python log level (bridge container) |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Detailed system design
- [Deployment](docs/DEPLOYMENT.md) — Step-by-step deployment guide
- [Status](STATUS.md) — Implementation tracker

## License

Internal — BigHat Biosciences
