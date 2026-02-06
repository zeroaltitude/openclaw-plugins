# Status Tracker

## Implementation

| Component | Status | Notes |
|-----------|--------|-------|
| Monorepo structure | ✅ Done | All directories and files created |
| FastAPI server (`server/app/`) | ✅ Done | main.py, mcp_client.py, auth.py, models.py |
| MCP JSON-RPC client | ✅ Done | NDJSON framing, lifecycle lock, stderr drain, tool discovery |
| Bearer auth middleware | ✅ Done | Required by default, timing-safe comparison, ALLOW_ANONYMOUS opt-in |
| Health endpoint | ✅ Done | Returns 503 when unhealthy; separate /readyz endpoint |
| Pydantic models | ✅ Done | All request/response types |
| Unit tests | ✅ Done | Model + auth tests with conftest.py for imports |
| OpenClaw plugin | ✅ Done | 5 tools, CJS module, request timeouts, response parsing |
| Dockerfile | ✅ Done | Binary checksum, UID 1000, embedding cache on /data |
| docker-compose.yml | ✅ Done | Local dev with volume persistence + FASTEMBED_CACHE_PATH |
| Helm chart | ✅ Done | Startup probe, ALB cert, security hardening, secret validation |
| README.md | ✅ Done | Overview, architecture diagram, quickstart |
| ARCHITECTURE.md | ✅ Done | Detailed data flow, NDJSON framing, cache paths, security model |
| DEPLOYMENT.md | ✅ Done | Step-by-step with auth requirements, probe info |

## Code Review Fixes (GPT-5.2 Pro)

### Critical

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | MCP Transport Framing | ✅ Fixed | Documented NDJSON choice matching rmcp crate |
| 2 | stderr Deadlock | ✅ Fixed | Background asyncio task drains stderr |
| 3 | Subprocess Race Condition | ✅ Fixed | lifecycle_lock prevents duplicate spawns |
| 4 | Health 200 When Unhealthy | ✅ Fixed | Returns 503, added /readyz endpoint |
| 5 | Auth Silently Disabled | ✅ Fixed | Empty token = error, requires ALLOW_ANONYMOUS for open access |
| 6 | Plugin Module System | ✅ Fixed | CJS module + node16 resolution |

### Major

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 7 | Dockerfile Binary Checksum | ✅ Fixed | SHA256 verification (placeholder, needs pinning) |
| 8 | Embedding Cache Not on PVC | ✅ Fixed | Moved to /data/.cache/vestige/fastembed |
| 9 | UID Mismatch | ✅ Fixed | Explicit UID/GID 1000 in Dockerfile |
| 10 | Tool Name Verification | ✅ Fixed | tools/list at startup, logged to console |
| 11 | Context Header Override | ✅ Fixed | agent_id prepended, user context preserved |
| 12 | Response Handling | ✅ Fixed | Content array extracted in client + plugin |
| 13 | Startup Probe | ✅ Fixed | 30×10s = 5min budget for model download |
| 14 | ALB Certificate | ✅ Fixed | Optional certificateArn in ingress |

### Minor

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 15 | Unused imports in main.py | ✅ Fixed | Removed Request, JSONResponse |
| 16 | secrets.compare_digest | ✅ Fixed | Timing-safe token comparison |
| 17 | Test imports | ✅ Fixed | conftest.py with sys.path setup |
| 18 | requirements-dev.txt | ✅ Fixed | pytest + pytest-asyncio + httpx |
| 19 | Duplicate dist/ in .gitignore | ✅ Fixed | Removed top-level dist/ duplicate |
| 20 | Plugin request timeouts | ✅ Fixed | AbortController with 30s timeout |
| 21 | Plugin trailing slash | ✅ Fixed | serverUrl stripped of trailing slashes |
| 22 | _proc = None after stop | ✅ Fixed | Reset in stop() method |
| 23 | Assert → explicit checks | ✅ Fixed | Raise MCPConnectionError instead |
| 24 | Helm version labels | ✅ Fixed | app.kubernetes.io/version added |
| 25 | Container securityContext | ✅ Fixed | Drop ALL caps, no privilege escalation |

## Pre-Deployment (Requires Human)

| Task | Status | Owner |
|------|--------|-------|
| Create ECR repository | ⬜ Not Started | Eddie / Infra |
| Build & push Docker image | ⬜ Not Started | CI/CD or manual |
| Pin VESTIGE_SHA256 checksum | ⬜ Not Started | Eddie |
| Create k8s namespace | ⬜ Not Started | Eddie / Infra |
| Generate auth token | ⬜ Not Started | Eddie |
| DNS for vestige.internal | ⬜ Not Started | Eddie / Infra |
| ACM certificate (if HTTPS needed) | ⬜ Not Started | Eddie / Infra |
| Install Helm release | ⬜ Not Started | Eddie |
| Configure OpenClaw plugin settings | ⬜ Not Started | Eddie |
| End-to-end integration test | ⬜ Not Started | Eddie + Tabitha |

## Known Considerations

- **First-boot model download**: Vestige downloads Nomic Embed (~130MB) on first run. Startup probe gives 5 minutes. Cache persists on PVC.
- **Single replica**: SQLite constraint. Fine for expected load. PostgreSQL migration path documented if needed.
- **Agent namespacing**: `X-Agent-Id` is passed as context to Vestige but true multi-tenant isolation would need per-agent data directories.
- **Binary checksum**: The Dockerfile SHA256 is a placeholder — must be pinned to actual release artifact before production.
