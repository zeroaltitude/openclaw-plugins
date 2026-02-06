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
                                        └──────────┬───────────────┘
                                                   │
                                          MCP JSON-RPC (stdio)
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
A thin FastAPI application (~200 lines) that:
- Spawns `vestige-mcp` as a child process on startup
- Translates HTTP requests into MCP JSON-RPC tool calls over stdio
- Provides bearer token authentication
- Passes agent identity via `X-Agent-Id` header
- Auto-restarts the subprocess on crash

### Plugin (`plugin/`)
An OpenClaw TypeScript plugin that registers five tools:
- `vestige_search` — Hybrid keyword + semantic memory search
- `vestige_ingest` — Direct memory storage
- `vestige_smart_ingest` — Intelligent ingestion with duplicate detection
- `vestige_promote` — Strengthen a memory (mark as helpful)
- `vestige_demote` — Weaken a memory (mark as wrong)

### Docker (`docker/`)
Multi-stage Dockerfile:
1. Downloads pre-built vestige binaries from GitHub releases
2. Ubuntu 24.04 runtime (GLIBC 2.39 required) + Python 3.12 + FastAPI

### Helm Chart (`helm/vestige/`)
Production k8s deployment with:
- Single-replica Deployment (SQLite constraint)
- 5Gi PVC for data persistence
- Internal ALB ingress
- Liveness/readiness probes
- Secret management for auth token

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `VESTIGE_AUTH_TOKEN` | *(none)* | Bearer token for API auth. Unset = open access. |
| `VESTIGE_DATA_DIR` | `/data` | SQLite database directory |
| `VESTIGE_BINARY` | `vestige-mcp` | Path to vestige-mcp binary |
| `FASTEMBED_CACHE_PATH` | `~/.cache/vestige/fastembed` | Embedding model cache |
| `LOG_LEVEL` | `info` | Python log level |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Detailed system design
- [Deployment](docs/DEPLOYMENT.md) — Step-by-step deployment guide
- [Status](STATUS.md) — Implementation tracker

## License

Internal — BigHat Biosciences
