# Design: Per-Agent Memory Strength

**Status:** Proposed  
**Date:** 2026-02-07  
**Authors:** Eddie Abrams, Tabitha  

## Problem

Today, Vestige has a single global memory store. When any agent promotes or demotes a memory, it affects the FSRS retention strength globally — for all agents. Similarly, the Testing Effect (retrieval strengthens memory) applies globally regardless of which agent did the search.

This means:
- Agent A's promote makes a memory stronger for Agent B, even if Agent B has never seen it
- Agent A's demote weakens a memory that Agent B might find valuable
- A single agent that searches aggressively inflates retention strength for everyone
- There's no way to distinguish "the team collectively trusts this memory" from "one agent used it once"

As more people (and their agents) share the same Vestige instance, this becomes a real limitation. An engineer's agent debugging a pipeline issue shouldn't affect the memory landscape for a scientist's agent reviewing experiment results.

## Goals

1. **Per-agent retention strength** — promote/demote and retrieval strengthening are scoped to the acting agent
2. **Shared content** — memory content, embeddings, tags, and dedup logic remain global
3. **Collective signal** — popular memories (reinforced by many agents) should naturally surface higher
4. **Backward compatible** — existing memories and agents without identity work as before
5. **Configurable agent identity** — each OpenClaw instance sets its own agent name (not hardcoded)

## Non-Goals

- Per-agent content isolation / access control (see [ACL-SHARING.md](ACL-SHARING.md) for that)
- Multi-tenancy or workspace separation
- Agent-to-agent memory delegation

## Design

### Layer 1: Agent Identity in OpenClaw Plugin

**Current state:** The plugin hardcodes `const agentId = "tabitha"` in `plugin/src/index.ts`.

**Change:** Read the agent name from plugin config:

```typescript
// plugin/src/index.ts
const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
const agentId = (cfg.agentId as string) ?? "default";
```

OpenClaw users configure it in `openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "vestige": {
        "agentId": "tabitha",
        "serverUrl": "https://vestige.internal",
        "authToken": "..."
      }
    }
  }
}
```

Each OpenClaw instance gets a unique name. If unconfigured, falls back to `"default"`.

**Effort:** ~10 minutes. Ship independently as a quick win.

### Layer 2: Per-Agent Memory State in vestige-mcp

This is the core change, living in the Rust binary.

#### New Table: `agent_memory_state`

```sql
CREATE TABLE agent_memory_state (
    agent_id    TEXT    NOT NULL,
    memory_id   TEXT    NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    stability   REAL    NOT NULL DEFAULT 1.0,   -- FSRS stability (per-agent)
    difficulty  REAL    NOT NULL DEFAULT 0.5,    -- FSRS difficulty (per-agent)
    retrievals  INTEGER NOT NULL DEFAULT 0,      -- agent-local retrieval count
    last_review TEXT,                             -- last promote/demote timestamp
    last_access TEXT,                             -- last search retrieval timestamp
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, memory_id)
);

CREATE INDEX idx_ams_agent ON agent_memory_state(agent_id);
CREATE INDEX idx_ams_memory ON agent_memory_state(memory_id);
```

#### Modified Behavior

**Promote/Demote:**
- Update `agent_memory_state` for the calling agent (create row if first interaction)
- Also update a **global popularity signal** (see below)
- Do NOT modify the base memory's global FSRS parameters

**Search (retrieval):**
- Compute `effective_strength` by blending global and agent-local:
  ```
  effective = α * global_retention + (1 - α) * agent_retention
  ```
  Where `α` depends on whether an agent-local row exists:
  - No agent row → `α = 1.0` (pure global, backward compatible)
  - Agent row exists → `α = 0.3` (agent opinion dominates, global provides baseline)
  - `α` could be configurable per deployment
- Apply Testing Effect to the **agent-local** row, not global
- Rank results by `relevance × effective_strength`

**Smart Ingest:**
- Prediction error gating remains global (dedup is shared)
- When creating a new memory, no agent-local rows exist yet (pure global until first interaction)
- The ingesting agent could optionally get an initial agent row (representing "I created this")

#### Global Popularity Signal

Add a lightweight popularity metric to the base `memories` table:

```sql
ALTER TABLE memories ADD COLUMN promote_agents INTEGER DEFAULT 0;  -- distinct agents who promoted
ALTER TABLE memories ADD COLUMN demote_agents  INTEGER DEFAULT 0;  -- distinct agents who demoted
ALTER TABLE memories ADD COLUMN popularity     REAL    DEFAULT 0;  -- computed score
```

When an agent promotes a memory for the first time (no prior agent row, or prior state was demoted):
- Increment `promote_agents`
- Recalculate: `popularity = (promote_agents - demote_agents) / total_agents_seen`

This gives us a "collective trust" signal that can optionally boost global retention:
```
boosted_global = base_global * (1 + β * popularity)
```

A memory promoted by 8 out of 10 agents is probably more valuable than one promoted by 1.

### Layer 3: Bridge Changes

The FastAPI bridge already passes `X-Agent-Id` to vestige-mcp. The main change is ensuring the MCP tool arguments include `agent_id` as a first-class field (not just in the context string):

```python
# Current: agent_id is stuffed into context
result["context"] = f"agent:{agent_id} | {result['context']}"

# New: agent_id is a separate argument
if agent_id:
    result["agent_id"] = agent_id
```

vestige-mcp would need to accept `agent_id` as an optional parameter on `search`, `promote_memory`, `demote_memory`, and optionally `smart_ingest`.

## Migration

1. **New table creation** — vestige-mcp runs migrations on startup; add `agent_memory_state` table
2. **Existing memories** — No migration needed. Memories without agent-local rows use pure global strength (backward compatible)
3. **Existing promote/demote history** — Lost (we don't know which agent did past promotes). This is acceptable; the system rebuilds agent-local state organically through use
4. **Plugin update** — Ship configurable `agentId` first. Existing hardcoded `"tabitha"` gets an agent row naturally

## Search Scoring Example

Memory M has:
- Global retention: `0.6`
- Tabitha's agent retention: `0.9` (she promoted it)
- Boris's agent retention: none (never interacted)
- Relevance score: `0.8`

**Tabitha searches:**
```
effective = 0.3 * 0.6 + 0.7 * 0.9 = 0.81
final = 0.8 * 0.81 = 0.648
```

**Boris searches:**
```
effective = 1.0 * 0.6 = 0.6  (no agent row, pure global)
final = 0.8 * 0.6 = 0.48
```

Tabitha sees this memory ranked higher because she's reinforced it. Boris sees it at the global baseline. Over time, if Boris also promotes it, his effective score rises and the global popularity signal strengthens the baseline for everyone.

## Implementation Plan

### Phase 1: Agent Identity (Plugin only)
- [ ] Make `agentId` configurable in plugin config
- [ ] Remove hardcoded `"tabitha"`
- [ ] Update README with config example
- [ ] Ship as plugin patch release

### Phase 2: Per-Agent State (vestige-mcp)
- [ ] Add `agent_memory_state` table + migration
- [ ] Accept `agent_id` parameter on promote/demote tools
- [ ] Write agent-local FSRS state on promote/demote
- [ ] Add popularity counters to memories table
- [ ] Update search scoring to blend global + agent-local
- [ ] Apply Testing Effect to agent-local row
- [ ] Tests for all of the above

### Phase 3: Bridge + Integration
- [ ] Pass `agent_id` as first-class MCP argument (not just context string)
- [ ] Add `GET /agents` endpoint to list agents with memory stats
- [ ] Integration tests with multiple agent identities
- [ ] Update ARCHITECTURE.md

### Phase 4: Tuning
- [ ] Make blending factor `α` configurable
- [ ] Evaluate popularity boost factor `β`
- [ ] Consider agent-local Testing Effect strength
- [ ] Dashboarding: per-agent memory stats

## Open Questions

1. **Should ingest create an agent-local row for the ingesting agent?** Argument for: "I wrote this, I trust it." Argument against: unnecessary state; the agent can promote it if they want.

2. **Should the blending factor α be dynamic?** e.g., newer agent rows get less weight until they have enough interactions to be meaningful.

3. **Should we expose a "view as agent X" search mode** for debugging? Like `search(..., as_agent="tabitha")` to see what another agent would see.

4. **Rate limiting on promote/demote?** Prevent a rogue agent from spamming promotes to game the popularity signal.

5. **Should demote be reversible?** If I demote then later promote, does the global popularity signal handle the transition cleanly?

## References

- Bjork, R.A. & Bjork, E.L. (1992). A new theory of disuse and an old theory of stimulus fluctuation.
- FSRS-6: https://github.com/open-spaced-repetition/fsrs-rs
- Vestige MCP: https://github.com/samvallad33/vestige
- [ACL-SHARING.md](ACL-SHARING.md) — Related work on access control
- [ARCHITECTURE.md](ARCHITECTURE.md) — Current system architecture
