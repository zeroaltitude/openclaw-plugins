# Status Tracker

## Implementation

| Component | Status | Notes |
|-----------|--------|-------|
| Monorepo structure | ✅ Done | All directories and files created |
| FastAPI server (`server/app/`) | ✅ Done | main.py, mcp_client.py, auth.py, models.py |
| MCP JSON-RPC client | ✅ Done | Full initialize handshake + tool call support |
| Bearer auth middleware | ✅ Done | Token via `VESTIGE_AUTH_TOKEN` env var |
| Pydantic models | ✅ Done | All request/response types |
| Unit tests | ✅ Done | Model + auth tests |
| OpenClaw plugin | ✅ Done | 5 tools: search, ingest, smart_ingest, promote, demote |
| Dockerfile | ✅ Done | Multi-stage: download binaries + Ubuntu 24.04 runtime |
| docker-compose.yml | ✅ Done | Local dev with volume persistence |
| Helm chart | ✅ Done | Deployment, Service, Ingress, PVC, Secret |
| README.md | ✅ Done | Overview, architecture diagram, quickstart |
| ARCHITECTURE.md | ✅ Done | Detailed data flow, MCP protocol, memory science |
| DEPLOYMENT.md | ✅ Done | Step-by-step with Helm + ECR |

## Pre-Deployment (Requires Human)

| Task | Status | Owner |
|------|--------|-------|
| Create ECR repository | ⬜ Not Started | Eddie / Infra |
| Build & push Docker image | ⬜ Not Started | CI/CD or manual |
| Create k8s namespace | ⬜ Not Started | Eddie / Infra |
| Generate auth token | ⬜ Not Started | Eddie |
| DNS for vestige.internal | ⬜ Not Started | Eddie / Infra |
| Install Helm release | ⬜ Not Started | Eddie |
| Configure OpenClaw plugin settings | ⬜ Not Started | Eddie |
| End-to-end integration test | ⬜ Not Started | Eddie + Tabitha |

## Known Considerations

- **First-boot model download**: Vestige downloads Nomic Embed (~130MB) on first run. Could pre-bake into Docker image if we find the cache path is stable.
- **Single replica**: SQLite constraint. Fine for expected load. PostgreSQL migration path documented if needed.
- **Agent namespacing**: `X-Agent-Id` is passed as context to Vestige but true multi-tenant isolation would need per-agent data directories.
