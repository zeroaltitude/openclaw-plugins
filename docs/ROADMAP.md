# Roadmap: Fork Vestige, Kill Supergateway, Close the Analytics Loop

**Date:** 2026-02-07
**Status:** Approved for planning — not yet in progress
**Authors:** Eddie Abrams, Tabitha
**Collaborators:** Hatbot, Anisha Keshavan

---

## Executive Summary

Three separate initiatives — removing supergateway, adding HTTP/2 support, and
building success analytics — converge into one project: **fork vestige-mcp and
build a proper server**. This eliminates architectural debt, enables native
concurrency, and opens the door to self-calibrating memory.

```
Current stack (4 hops, 3 processes):
  Agent → Plugin (HTTP) → FastAPI Bridge → supergateway (Node.js) → vestige-mcp (Rust, stdio)

Target stack (2 hops, 2 processes):
  Agent → Plugin (HTTP) → FastAPI Bridge → vestige-mcp-fork (Rust, native HTTP/2)
                               ↑
                    analytics + experiments layer
```

---

## Motivation

### Problem 1: Supergateway is unnecessary overhead

Supergateway wraps vestige-mcp's stdio interface and exposes it as Streamable
HTTP. This adds:

- A **Node.js runtime dependency** to the vestige container
- A **per-session process spawn** (each MCP session gets a new vestige-mcp
  subprocess, each loading its own copy of the Nomic Embed model at ~130MB)
- An **extra network hop** (bridge → supergateway → vestige-mcp)
- **Session management complexity** the bridge doesn't need

### Problem 2: No native HTTP/2

The bridge currently speaks HTTP/1.1 to supergateway. HTTP/2 would give us
multiplexed streams over a single connection — no head-of-line blocking, better
connection reuse, and lower latency for concurrent requests from multiple agents.

### Problem 3: Success analytics has no home

The [EXPERIMENTS.md](./EXPERIMENTS.md) spec defines a rich analytics and A/B
testing layer, but it currently requires a separate SQLite DB and ad-hoc
instrumentation. Some of these signals (memory usefulness, retention accuracy)
are fundamentally **memory quality signals** that belong in Vestige's own
scoring system.

### Problem 4: GLIBC version mismatch

The upstream vestige-mcp binary requires GLIBC 2.38. Our WSL2 host runs Ubuntu
22.04 (GLIBC 2.35). It only runs in containers today. A forked build targeting
musl (static binary) or our specific glibc version eliminates this friction.

---

## Architecture: What Goes Where

The FastAPI bridge remains the **auth, experiment, and instrumentation** layer.
The forked vestige-mcp becomes a **proper HTTP/2 server** with additional tools
for feedback and analytics.

```
┌──────────────────┐     HTTP/JSON       ┌──────────────────────────────┐
│  OpenClaw Agent   │ ──────────────────▶ │  FastAPI Bridge              │
│  (plugin)         │                     │                              │
│  vestige_search   │  Authorization:     │  Auth (bearer token)         │
│  vestige_ingest   │  Bearer <token>     │  Experiment router           │
│  vestige_smart_.. │  X-Agent-Id: ...    │  Request/response logging    │
│  vestige_promote  │                     │  A/B variant injection       │
│  vestige_demote   │                     │  Feature flags               │
│  vestige_feedback │                     │  Q&A eval pair generation    │
└──────────────────┘                     │                              │
                                         └──────────┬───────────────────┘
                                                    │
                                          HTTP/2 (h2c, persistent)
                                           localhost:3100
                                                    │
                                         ┌──────────▼───────────────────┐
                                         │  vestige-mcp-fork            │
                                         │  (Rust binary, native HTTP)  │
                                         │                              │
                                         │  Core: SQLite + Nomic Embed  │
                                         │        FSRS-6 + dual-strength│
                                         │                              │
                                         │  New:  /mcp (Streamable HTTP)│
                                         │        feedback tool         │
                                         │        stats tool            │
                                         │        retention analytics   │
                                         └──────────────────────────────┘
```

### Responsibility Split

| Concern | Layer | Rationale |
|---------|-------|-----------|
| Bearer token auth, agent identity | Bridge | Security boundary, first hop |
| Experiment assignment & feature flags | Bridge | Per-request routing decisions |
| Request/response event logging | Bridge | Instrumentation point for A/B |
| A/B variant parameter injection | Bridge | Modifies tool arguments before forwarding |
| Q&A eval pair generation | Bridge | Requires LLM call (model access) |
| Memory storage, retrieval, FSRS scoring | Vestige fork | Core engine |
| Retention analytics & decay curves | Vestige fork | Direct access to FSRS state |
| Feedback ingestion (memory usefulness) | Vestige fork | Closes the learning loop internally |
| Embedding + similarity search | Vestige fork | Hot path, Rust perf matters |

---

## Phase 1: Fork & Build Native HTTP (~1 day)

**Goal:** Replace supergateway with native HTTP in the Rust binary.

### Tasks

1. **Fork vestige-mcp** into `BigHat-Biosciences/vestige-mcp` (or a `vestige/`
   subdirectory in this repo)
2. **Enable rmcp HTTP transport** — the `rmcp` crate already has a Streamable
   HTTP feature; it's just not enabled in the upstream build
3. **Add axum/hyper HTTP server** — expose `/mcp` endpoint natively, supporting
   both HTTP/1.1 and HTTP/2 (h2c for local, h2 with TLS for remote)
4. **Build with musl** for a fully static binary (fixes GLIBC 2.38 issue,
   runs on any Linux)
5. **Dockerfile** — single-stage build, no Node.js, no supergateway
6. **Test** — bridge connects directly to vestige-fork on port 3100

### What Changes

| Component | Before | After |
|-----------|--------|-------|
| vestige-mcp transport | stdio only | stdio + native HTTP/2 |
| supergateway | Required (Node.js wrapper) | **Eliminated** |
| Node.js dependency | Required in vestige container | **Eliminated** |
| GLIBC requirement | 2.38 (breaks on Ubuntu 22.04) | None (musl static) |
| Processes per session | 1 new vestige-mcp per MCP session | 1 persistent server for all |
| Embedding model loads | Per session (wasteful) | Once at startup |

### Validation

- All existing plugin tools (search, ingest, smart_ingest, promote, demote)
  work identically
- Latency equal or better than supergateway path
- Memory footprint: one vestige process vs. N per-session processes

---

## Phase 2: Bridge Simplification (~half day)

**Goal:** Remove all supergateway references, simplify deployment.

### Tasks

1. Update `mcp_client.py` to connect to vestige-fork's native HTTP endpoint
   (minimal change — same JSON-RPC, different transport)
2. Delete `Dockerfile.vestige` (supergateway wrapper)
3. Update `docker-compose.yml` — vestige service now runs the fork directly
4. Update Helm chart — vestige container uses fork image, no Node.js
5. Optionally: merge into single container (bridge + vestige-fork binary)
   for simplest possible deployment

### Deployment Options

**Option A: Two containers (recommended for k8s)**
- Bridge container: Python + FastAPI (port 8000)
- Vestige container: Rust binary (port 3100)
- Communicate over localhost within pod

**Option B: Single container (simplest)**
- Bridge spawns vestige-fork as a subprocess OR runs it as a background task
- Single port (8000), bridge proxies to localhost:3100
- Best for Docker Compose / dev environments

---

## Phase 3: Analytics Instrumentation (~1-2 days)

**Goal:** Implement the experiment and analytics layer per [EXPERIMENTS.md](./EXPERIMENTS.md).

### Tasks

1. **Experiment router** in the bridge — assignment strategies (per-request,
   per-agent, per-session, shadow)
2. **Feature flags** — YAML config + REST API for dynamic changes
3. **Request/response interceptors** — log every tool call with experiment
   context to analytics SQLite DB
4. **Analytics API endpoints** — `/analytics/queries`, `/analytics/usage`,
   `/analytics/retention-curves`, `/experiments/{id}/results`
5. **Shadow mode** — run both variants, return control, log both results

### Analytics Event Schema

```json
{
  "request_id": "uuid",
  "timestamp": "2026-02-10T14:30:00Z",
  "agent_id": "tabitha",
  "session_id": "abc123",
  "operation": "search",
  "query": "what EBS volume type do we use",
  "experiment_id": "retention-threshold-v2",
  "variant": "high-threshold",
  "params_applied": { "min_retention": 0.7 },
  "results_count": 3,
  "results_ids": ["mem_001", "mem_042", "mem_107"],
  "latency_ms": 47,
  "shadow_results": null
}
```

### Initial Tuneable Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `min_retention` | 0.4 | 0.0–1.0 | Minimum FSRS retention to return |
| `max_results` | 10 | 1–50 | Max memories per search |
| `cross_agent_scope` | true | bool | Search other agents' namespaces |
| `prediction_error_threshold` | 0.3 | 0.0–1.0 | Create vs. update threshold |
| `embedding_similarity_threshold` | 0.7 | 0.0–1.0 | Min similarity for results |

---

## Phase 4: Vestige-Native Feedback (~1-2 days)

**Goal:** Add tools to the forked vestige-mcp that close the learning loop.

### New MCP Tools

#### `feedback`

Agent reports whether a previously retrieved memory was useful or not.
This is an automated promote/demote that the bridge can trigger based on
conversation outcome.

```json
{
  "memory_id": "mem_042",
  "signal": "useful",
  "context": "Agent used this memory to correctly answer a question about EBS volumes"
}
```

Signals: `useful` (strengthen), `irrelevant` (weaken), `wrong` (strong demote),
`outdated` (supersede candidate).

The bridge can generate these automatically:
- If the agent's response references a retrieved memory → `useful`
- If retrieved memories were ignored entirely → `irrelevant`
- If the human corrects the agent after retrieval → `wrong`

#### `stats`

Expose retention analytics directly from Vestige's FSRS data:

```json
{
  "total_memories": 847,
  "active": 312,
  "dormant": 289,
  "silent": 246,
  "avg_retention_strength": 0.62,
  "promote_demote_ratio": 4.2,
  "prediction_error_gating": {
    "create": 156,
    "update": 89,
    "reinforce": 402,
    "supersede": 12
  },
  "top_tags": ["bug-fix", "preference", "architecture", "vestige"]
}
```

No separate analytics DB needed for these — they come straight from
Vestige's SQLite.

### Automatic Feedback Pipeline

```
1. Agent calls vestige_search("EBS volume type")
2. Bridge logs: request_id=X, results=[mem_042, mem_107, mem_203]
3. Agent responds using info from mem_042
4. Bridge detects: agent referenced mem_042 content in response
5. Bridge calls vestige feedback(mem_042, "useful")
6. Vestige strengthens mem_042's retrieval strength via FSRS
7. Next time: mem_042 ranks higher in similar searches
```

This is the **testing effect on steroids** — not just "retrieval strengthens
memory" (which Vestige already does), but "successful retrieval strengthens
memory MORE than unsuccessful retrieval."

---

## Phase 5: Self-Calibrating Memory (Research, Ongoing)

**Goal:** Use collected feedback data to automatically tune FSRS parameters
and retrieval thresholds.

This is the long-term vision. With enough feedback data:

- **Calibrate FSRS decay rates** — are memories fading too fast or too slow?
  Compare predicted retention vs. actual usefulness at retrieval time.
- **Tune similarity thresholds** — run A/B experiments on
  `embedding_similarity_threshold` and measure precision/recall.
- **Adaptive compaction** — identify memories that are never retrieved and
  candidates for consolidation.
- **Per-agent tuning** — different agents may have different optimal parameters
  (e.g., a coding agent needs more precise recall, a chat agent needs broader
  association).

### The Dream Metric

From the [Evaluation Protocol](./EVALUATION.md):

> **"How often does a human have to re-explain something they already said?"**
> If that goes down, we're winning.

With the feedback loop closed, we can measure this directly:
- Agent retrieves relevant memory → no re-explanation needed → `useful` signal
- Agent fails to retrieve → human re-explains → correction ingested → memory
  strengthened for next time
- Over time, the system self-corrects: frequently re-explained topics get
  stronger memories, rarely-needed facts gracefully decay.

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Fork maintenance burden (upstream changes) | Medium | Cherry-pick upstream fixes; our additions are additive (new tools + transport), not invasive |
| Rust build complexity (musl, cross-compile) | Low | Well-documented in Rust ecosystem; CI with `cross` tool |
| SQLite contention with native HTTP concurrency | Low | WAL mode (already default); reads are concurrent, writes serialize; not a bottleneck at our scale |
| Bridge feedback detection is heuristic | Medium | Start with explicit promote/demote; automated feedback is Phase 4+ |
| Analytics DB growth | Low | Configurable retention (default 90 days), lightweight events |
| Breaking existing deployment | Low | Phase 1 is additive (new transport); old stdio mode still works |

---

## Effort Estimates

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Fork & native HTTP | ~1 day | Rust toolchain, rmcp docs |
| Phase 2: Bridge simplification | ~0.5 day | Phase 1 |
| Phase 3: Analytics instrumentation | ~1-2 days | Independent of Phase 1-2 |
| Phase 4: Vestige-native feedback | ~1-2 days | Phase 1 (fork exists) |
| Phase 5: Self-calibrating memory | Ongoing | Phase 3 + 4 data |

Phases 1-2 and Phase 3 can proceed in parallel.

---

## Success Criteria

### Phase 1-2 (Infrastructure)
- [ ] vestige-mcp-fork serves HTTP/2 natively
- [ ] supergateway fully removed from all Dockerfiles and compose configs
- [ ] Static musl binary runs on Ubuntu 22.04 WSL2 without GLIBC issues
- [ ] Latency ≤ current supergateway path
- [ ] All existing plugin tools pass integration tests

### Phase 3 (Analytics)
- [ ] Every vestige request logged with experiment context
- [ ] At least one A/B experiment running (e.g., retention threshold)
- [ ] Analytics API returns meaningful data after 1 week of usage
- [ ] Feature flags can toggle cross-agent retrieval per-agent

### Phase 4 (Feedback)
- [ ] `feedback` tool integrated into forked vestige-mcp
- [ ] Bridge generates at least 1 automated feedback signal per search
- [ ] Promote/demote ratio reflects actual memory usefulness
- [ ] `stats` tool returns live retention analytics

### Phase 5 (Self-Calibration)
- [ ] Re-explanation rate measurably decreases over 30 days
- [ ] FSRS parameters adjusted based on feedback data
- [ ] Cross-agent recall rate >70% for high-salience facts

---

## Related Documents

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Current system architecture
- [EVALUATION.md](./EVALUATION.md) — Evaluation protocol and metrics
- [EXPERIMENTS.md](./EXPERIMENTS.md) — Analytics layer design spec
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Current deployment guide
- [vestige-direct-stdio-bridge.md](../../.openclaw/workspace/plans/vestige-direct-stdio-bridge.md) — Earlier plan (superseded by this roadmap)

---

## Open Questions

1. **Repo structure:** Separate repo (`BigHat-Biosciences/vestige-mcp`) or
   subdirectory in this monorepo? Separate repo is cleaner for CI/releases;
   subdirectory is easier for cross-cutting changes.

2. **Upstream contribution:** Should we contribute the HTTP transport back
   upstream? The fork is mainly additive — native HTTP is useful for everyone.

3. **Feedback heuristics:** How accurately can the bridge detect whether an
   agent "used" a retrieved memory? String matching? Semantic similarity
   between memory content and agent response? LLM judge?

4. **Multi-tenant analytics:** If we open this to other teams, experiment
   and analytics data need tenant isolation. Worth thinking about now or
   later?

5. **Embedding model choice:** Forking lets us experiment with different
   embedding models (e.g., newer Nomic versions, or domain-specific models
   for biotech). Should we make this configurable?
