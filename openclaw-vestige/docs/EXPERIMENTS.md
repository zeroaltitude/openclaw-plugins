# Experiment & Analytics Layer — Design Spec (DRAFT)

**Date:** 2026-02-06  
**Status:** Spec only — not yet implemented. Awaiting design review.  
**Contributors:** Eddie Abrams, Tabitha, Hatbot, Anisha Keshavan

---

## Motivation

The FastAPI sidecar sits between every OpenClaw agent and the Vestige cognitive engine. This makes it the ideal instrumentation point for:

1. **A/B testing** memory retrieval strategies without modifying Vestige or agents
2. **Feature flags** for incremental rollout of new memory behaviors
3. **Hyperparameter tuning** (decay rates, thresholds, compaction policies)
4. **Analytics** on how agents actually use (or ignore) retrieved memories
5. **Baseline comparison** (Vestige vs. no-Vestige, per Evaluation Protocol)

The key constraint: **Vestige stays unmodified.** All experiment logic lives in the sidecar.

---

## Architecture

```
Agent (OpenClaw plugin)
  │
  ▼
┌─────────────────────────────────┐
│  FastAPI Sidecar                │
│  ┌───────────────────────────┐  │
│  │  Experiment Router        │  │
│  │  - Assignment             │  │
│  │  - Feature flags          │  │
│  │  - Parameter override     │  │
│  └───────────┬───────────────┘  │
│              │                  │
│  ┌───────────▼───────────────┐  │
│  │  Request Interceptor      │  │
│  │  - Log request + variant  │  │
│  │  - Apply overrides        │  │
│  │  - Shadow mode support    │  │
│  └───────────┬───────────────┘  │
│              │                  │
│  ┌───────────▼───────────────┐  │
│  │  MCP Client (Vestige)     │  │
│  └───────────┬───────────────┘  │
│              │                  │
│  ┌───────────▼───────────────┐  │
│  │  Response Interceptor     │  │
│  │  - Log results + latency  │  │
│  │  - Apply variant filters  │  │
│  │  - Record for scoring     │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │  Analytics Store          │  │
│  │  (SQLite, separate from   │  │
│  │   Vestige's memory DB)    │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

---

## Core Concepts

### Experiment

An experiment is a named configuration that varies one or more parameters across variants.

```json
{
  "id": "retention-threshold-v2",
  "description": "Test whether raising the retention threshold improves retrieval precision",
  "created": "2026-02-10T00:00:00Z",
  "status": "active",
  "variants": [
    {
      "name": "control",
      "weight": 50,
      "params": { "min_retention": 0.4 }
    },
    {
      "name": "high-threshold",
      "weight": 50,
      "params": { "min_retention": 0.7 }
    }
  ],
  "assignment": "per-request",
  "metrics": ["precision", "recall", "latency_ms"]
}
```

### Assignment Strategies

| Strategy | Description | Use When |
|----------|-------------|----------|
| `per-request` | Each request randomly assigned | Testing retrieval parameters |
| `per-agent` | Agent assigned to variant for experiment duration | Testing agent-level behaviors |
| `per-session` | Session assigned on first request | Testing within-session consistency |
| `shadow` | All requests get both variants; only control is returned | Safe testing of risky changes |

### Feature Flags

Simpler than full experiments — binary on/off per agent or globally.

```json
{
  "flags": {
    "cross_agent_retrieval": { "enabled": true, "agents": ["*"] },
    "summarization_compaction": { "enabled": false },
    "auto_promote_on_retrieval": { "enabled": true, "agents": ["tabitha"] }
  }
}
```

---

## API Extensions

### Experiment Management

```
GET    /experiments                    # List all experiments
POST   /experiments                    # Create experiment
GET    /experiments/{id}               # Get experiment + status
PATCH  /experiments/{id}               # Update (pause, adjust weights)
DELETE /experiments/{id}               # Archive experiment
GET    /experiments/{id}/results       # Aggregated results
GET    /experiments/{id}/events        # Raw event log
```

### Feature Flags

```
GET    /flags                          # List all flags
PUT    /flags/{name}                   # Set flag
DELETE /flags/{name}                   # Remove flag
```

### Analytics

```
GET    /analytics/queries              # Query log (with filters)
GET    /analytics/usage                # Per-agent usage stats
GET    /analytics/retention-curves     # Memory retention over time
GET    /analytics/experiment-report    # Cross-experiment comparison
```

### Request Headers (Agent → Sidecar)

These are set by the OpenClaw plugin or the experiment router:

| Header | Description |
|--------|-------------|
| `X-Agent-Id` | Agent identity (existing) |
| `X-Session-Id` | Session identifier for per-session assignment |
| `X-Experiment-Override` | Force a specific variant (for debugging) |

### Response Headers (Sidecar → Agent)

| Header | Description |
|--------|-------------|
| `X-Experiment` | Which experiment(s) were active |
| `X-Variant` | Which variant was assigned |
| `X-Request-Id` | Unique ID for correlating with analytics |

---

## Analytics Event Schema

Every request through the sidecar generates an analytics event:

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
  "vestige_latency_ms": 32,
  "shadow_results": null
}
```

For shadow mode, `shadow_results` contains what the alternate variant would have returned.

### Storage

- SQLite database, separate from Vestige's memory DB
- On the same PVC (e.g., `/data/analytics.db`)
- Retention: configurable, default 90 days
- Export: CSV/JSON dump endpoint for offline analysis

---

## Tuneable Parameters (Initial Set)

These are the knobs we'd want to experiment with first:

| Parameter | Description | Default | Range |
|-----------|-------------|---------|-------|
| `min_retention` | Minimum FSRS retention score to return a memory | 0.4 | 0.0–1.0 |
| `max_results` | Maximum memories returned per search | 10 | 1–50 |
| `cross_agent_scope` | Whether to search other agents' namespaces | true | bool |
| `prediction_error_threshold` | How different must new info be to create vs. update | 0.3 | 0.0–1.0 |
| `decay_rate_multiplier` | Scale factor on FSRS decay | 1.0 | 0.1–5.0 |
| `compaction_enabled` | Summarize old memories before retrieval | false | bool |
| `compaction_age_days` | Age threshold for compaction eligibility | 30 | 1–365 |
| `embedding_similarity_threshold` | Minimum similarity for search results | 0.7 | 0.0–1.0 |

### Note on Vestige Parameters

Some of these (like `min_retention`, `max_results`) can be passed as arguments to Vestige's MCP `search` tool. Others (like `compaction`, `decay_rate_multiplier`) would require sidecar-level logic wrapping Vestige calls. The sidecar can:
- Pre-filter results after Vestige returns them
- Post-process (compaction, summarization) before returning to agent
- Modify arguments before forwarding to Vestige

It **cannot** change Vestige's internal FSRS calculations — only influence what gets sent and what gets returned.

---

## Spaced Retrieval Integration

The experiment layer connects to the [Evaluation Protocol](./EVALUATION.md) §6 (Anisha's Protocol):

1. **Q&A pair generation** happens in the sidecar after `ingest` calls (LLM generates questions)
2. **Quiz scheduling** uses OpenClaw cron jobs
3. **Quiz execution** routes through the experiment layer with both Vestige-enabled and Vestige-disabled variants
4. **Scoring** compares against ground truth in the eval DB
5. **Experiment results** feed back into parameter tuning

```
ingest → generate Q&A → store in eval DB
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         quiz @ t+1d     quiz @ t+7d     quiz @ t+30d
              │               │               │
              ▼               ▼               ▼
         score + log     score + log     score + log
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    experiment results
                              ▼
                    parameter tuning
```

---

## Configuration

Experiments and flags are configured via:

1. **YAML file** mounted in the pod (for static config)
2. **REST API** (for dynamic changes without redeploy)
3. **Helm values** (for default experiment sets per environment)

```yaml
# experiments.yaml
experiments:
  - id: retention-threshold-v2
    status: active
    variants:
      - name: control
        weight: 50
        params: { min_retention: 0.4 }
      - name: high-threshold
        weight: 50
        params: { min_retention: 0.7 }

flags:
  cross_agent_retrieval: true
  summarization_compaction: false

analytics:
  enabled: true
  retention_days: 90
  export_format: json
```

---

## Open Design Questions

1. **Variant assignment persistence:** Where do we store which agent/session is assigned to which variant? In the analytics DB? In-memory with periodic flush?

2. **Statistical significance:** How many requests/queries before we can declare a variant winner? Need to define minimum sample sizes per experiment.

3. **Interaction effects:** If we run multiple experiments simultaneously, how do we handle interactions between them? (e.g., retention threshold AND compaction both active)

4. **Agent awareness:** Should agents know they're in an experiment? Arguments both ways — awareness could bias behavior, but transparency is a value.

5. **Rollback:** If a variant causes degraded performance, how quickly can we kill it? Should there be automatic "circuit breaker" logic?

6. **Privacy:** Analytics events contain query text. If we open-source this, we need configurable redaction.

7. **Vestige upstream changes:** If Vestige adds new MCP tools or changes behavior, how does the experiment layer adapt? Need versioning.

8. **Multi-tenant isolation:** In a shared deployment, experiments should be scopeable per-team or per-organization.

---

## Non-Goals (v1)

- ML-based automatic parameter optimization (manual analysis first)
- Real-time dashboards (export to notebook/grafana later)
- Multi-armed bandit / adaptive assignment (fixed weights first)
- Agent-side instrumentation (sidecar-only for now)
