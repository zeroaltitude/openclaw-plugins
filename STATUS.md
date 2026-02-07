# Status Tracker

## Implementation

| Component | Status | Notes |
|-----------|--------|-------|
| Monorepo structure | ✅ Done | All directories and files created |
| FastAPI server (`server/app/`) | ✅ Done | main.py, mcp_client.py, auth.py, models.py |
| MCP JSON-RPC client (HTTP) | ✅ Done | Streamable HTTP + SSE transport, auto-reconnect |
| Bearer auth middleware | ✅ Done | Required by default, timing-safe comparison, ALLOW_ANONYMOUS opt-in |
| Health endpoint | ✅ Done | Deep health check (pings Vestige), returns 503 when unreachable |
| Pydantic models | ✅ Done | All request/response types |
| Unit tests | ✅ Done | Model + auth tests with conftest.py for imports |
| OpenClaw plugin | ✅ Done | 5 tools, CJS module, request timeouts, response parsing |
| Dockerfile.vestige | ✅ Done | vestige-mcp + Node.js + supergateway, Streamable HTTP on 3100 |
| Dockerfile.bridge | ✅ Done | Python + FastAPI, connects to Vestige over HTTP |
| docker-compose.yml | ✅ Done | Two-service setup (vestige + bridge) with health checks |
| Helm chart (sidecar) | ✅ Done | Two containers per pod, shared PVC, separate probes |
| README.md | ✅ Done | Updated architecture diagram, quick start, Claude Code access |
| ARCHITECTURE.md | ✅ Done | Decoupled architecture, deployment patterns, transport modes |
| DEPLOYMENT.md | ✅ Done | Two-image build, sidecar pod architecture, per-container probes |

## v0.2 Refactor: Decoupled Architecture

| # | Change | Status | Notes |
|---|--------|--------|-------|
| 1 | Rewrite mcp_client.py | ✅ Done | HTTP client (httpx), no subprocess, Streamable HTTP + SSE |
| 2 | Update main.py | ✅ Done | connect/disconnect lifecycle, deep health check |
| 3 | Update models.py | ✅ Done | `vestige_process` → `vestige_connected` |
| 4 | Split Dockerfile | ✅ Done | Dockerfile.vestige + Dockerfile.bridge (legacy Dockerfile kept) |
| 5 | Update docker-compose.yml | ✅ Done | Two services: vestige (3100) + bridge (8000) |
| 6 | Update Helm deployment | ✅ Done | Sidecar pattern, separate images/resources/probes |
| 7 | Update Helm values | ✅ Done | vestigeImage + bridgeImage, per-container resources |
| 8 | Update ARCHITECTURE.md | ✅ Done | New diagram, supergateway layer, deployment patterns |
| 9 | Update README.md | ✅ Done | New architecture, Claude Code direct access |
| 10 | Update DEPLOYMENT.md | ✅ Done | Two-image build, sidecar troubleshooting |

## Code Review Fixes (GPT-5.2 Pro)

### Critical

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | MCP Transport Framing | ✅ Fixed | Now uses HTTP (Streamable HTTP) instead of stdio |
| 2 | stderr Deadlock | ✅ N/A | No subprocess — eliminated by architecture change |
| 3 | Subprocess Race Condition | ✅ N/A | No subprocess — eliminated by architecture change |
| 4 | Health 200 When Unhealthy | ✅ Fixed | Returns 503, deep health check pings Vestige |
| 5 | Auth Silently Disabled | ✅ Fixed | Empty token = error, requires ALLOW_ANONYMOUS for open access |
| 6 | Plugin Module System | ✅ Fixed | CJS module + node16 resolution |

### Major

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 7 | Dockerfile Binary Checksum | ✅ Fixed | SHA256 verification (placeholder, needs pinning) |
| 8 | Embedding Cache Not on PVC | ✅ Fixed | Moved to /data/.cache/vestige/fastembed |
| 9 | UID Mismatch | ✅ Fixed | Explicit UID/GID 1000 in both Dockerfiles |
| 10 | Tool Name Verification | ✅ Fixed | tools/list at startup, logged to console |
| 11 | Context Header Override | ✅ Fixed | agent_id prepended, user context preserved |
| 12 | Response Handling | ✅ Fixed | Content array extracted in client + plugin |
| 13 | Startup Probe | ✅ Fixed | Per-container probes: 5min vestige, 60s bridge |
| 14 | ALB Certificate | ✅ Fixed | Optional certificateArn in ingress |

### Minor

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 15 | Unused imports in main.py | ✅ Fixed | Cleaned up for new architecture |
| 16 | secrets.compare_digest | ✅ Fixed | Timing-safe token comparison |
| 17 | Test imports | ✅ Fixed | conftest.py with sys.path setup |
| 18 | requirements-dev.txt | ✅ Fixed | pytest + pytest-asyncio + httpx |
| 19 | Duplicate dist/ in .gitignore | ✅ Fixed | Removed top-level dist/ duplicate |
| 20 | Plugin request timeouts | ✅ Fixed | AbortController with 30s timeout |
| 21 | Plugin trailing slash | ✅ Fixed | serverUrl stripped of trailing slashes |
| 22 | _proc = None after stop | ✅ N/A | No subprocess |
| 23 | Assert → explicit checks | ✅ Fixed | Raise MCPConnectionError instead |
| 24 | Helm version labels | ✅ Fixed | app.kubernetes.io/version added |
| 25 | Container securityContext | ✅ Fixed | Drop ALL caps, no privilege escalation (both containers) |

## Pre-Deployment (Requires Human)

| Task | Status | Owner |
|------|--------|-------|
| Create ECR repositories (×2) | ⬜ Not Started | Eddie / Infra |
| Build & push Docker images (×2) | ⬜ Not Started | CI/CD or manual |
| Pin VESTIGE_SHA256 checksum | ⬜ Not Started | Eddie |
| Create k8s namespace | ⬜ Not Started | Eddie / Infra |
| Generate auth token | ⬜ Not Started | Eddie |
| DNS for vestige.internal | ⬜ Not Started | Eddie / Infra |
| ACM certificate (if HTTPS needed) | ⬜ Not Started | Eddie / Infra |
| Install Helm release | ⬜ Not Started | Eddie |
| Configure OpenClaw plugin settings | ⬜ Not Started | Eddie |
| End-to-end integration test | ⬜ Not Started | Eddie + Tabitha |

## Known Considerations

- **First-boot model download**: Vestige downloads Nomic Embed (~130MB) on first run. Vestige startup probe gives 5 minutes. Cache persists on PVC.
- **Single replica**: SQLite constraint. Fine for expected load. PostgreSQL migration path documented if needed.
- **Agent namespacing**: `X-Agent-Id` is passed as context to Vestige but true multi-tenant isolation would need per-agent data directories.
- **Binary checksum**: The Dockerfile SHA256 is a placeholder — must be pinned to actual release artifact before production.
- **supergateway dependency**: The vestige container depends on npm/supergateway for HTTP exposure. Consider native Streamable HTTP in Vestige (rmcp feature) as a future optimization.
