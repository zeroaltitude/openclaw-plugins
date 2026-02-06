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
                                          MCP JSON-RPC (stdio/NDJSON)
                                                   │
                                        ┌──────────▼───────────────┐
                                        │  vestige-mcp             │
                                        │  (Rust binary, unmodified)│
                                        │                          │
                                        │  SQLite + Nomic Embed    │
                                        │  FSRS-6 + dual-strength  │
                                        └──────────────────────────┘
```

## Quick Start (Local Dev)

```bash
# 1. Clone
git clone git@github.com:BigHat-Biosciences/openclaw-vestige.git
cd openclaw-vestige

# 2. Run with Docker Compose
cd docker
VESTIGE_AUTH_TOKEN=my-secret-token docker compose up --build

# 3. Test
curl http://localhost:8000/health

curl -X POST http://localhost:8000/search \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"query": "coding preferences"}'
```

## Project Structure

```
openclaw-vestige/
├── server/          # FastAPI HTTP bridge → vestige-mcp subprocess
├── plugin/          # OpenClaw TypeScript plugin (registers agent tools)
├── docker/          # Dockerfile + docker-compose.yml
├── helm/vestige/    # Kubernetes Helm chart
└── docs/            # Architecture & deployment docs
```

## Components

### Server (`server/`)
A thin FastAPI application that:
- Spawns `vestige-mcp` as a child process on startup
- Translates HTTP requests into MCP JSON-RPC tool calls over stdio (NDJSON framing)
- Discovers available tools via `tools/list` and logs them at startup
- Provides bearer token authentication (required by default)
- Passes agent identity via `X-Agent-Id` header (preserved alongside user context)
- Auto-restarts the subprocess on crash (with lifecycle locking to prevent races)
- Returns proper 503 status when unhealthy

### Plugin (`plugin/`)
An OpenClaw TypeScript plugin (CommonJS) that registers five tools:
- `vestige_search` — Hybrid keyword + semantic memory search
- `vestige_ingest` — Direct memory storage
- `vestige_smart_ingest` — Intelligent ingestion with duplicate detection
- `vestige_promote` — Strengthen a memory (mark as helpful)
- `vestige_demote` — Weaken a memory (mark as wrong)

The plugin includes request timeouts (30s) and parses MCP content from responses.

### Docker (`docker/`)
Multi-stage Dockerfile:
1. Downloads pre-built vestige binaries from GitHub releases (with SHA256 verification)
2. Ubuntu 24.04 runtime (GLIBC 2.39 required) + Python 3.12 + FastAPI
3. Runs as UID/GID 1000 matching Helm securityContext

### Helm Chart (`helm/vestige/`)
Production k8s deployment with:
- Single-replica Deployment (SQLite constraint)
- 5Gi PVC for data persistence (including embedding model cache)
- Internal ALB ingress with optional ACM certificate
- Liveness, readiness, and startup probes (5min startup budget for model download)
- Secret management for auth token (required — fails if empty)
- Container-level security hardening (drop ALL caps, no privilege escalation)

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `VESTIGE_AUTH_TOKEN` | *(required)* | Bearer token for API auth. Must be set. |
| `VESTIGE_ALLOW_ANONYMOUS` | `false` | Set to `true` to allow unauthenticated access (dev only) |
| `VESTIGE_DATA_DIR` | `/data` | SQLite database directory |
| `VESTIGE_BINARY` | `vestige-mcp` | Path to vestige-mcp binary |
| `FASTEMBED_CACHE_PATH` | `/data/.cache/vestige/fastembed` | Embedding model cache (should be on PVC) |
| `LOG_LEVEL` | `info` | Python log level |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Detailed system design
- [Deployment](docs/DEPLOYMENT.md) — Step-by-step deployment guide
- [Status](STATUS.md) — Implementation tracker

## License

Internal — BigHat Biosciences
