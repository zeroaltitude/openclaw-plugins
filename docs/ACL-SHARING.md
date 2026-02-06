# ACL & Memory Sharing — Implementation Plan

**Date:** 2026-02-06  
**Author:** Eddie Abrams (specification), Tabitha (documentation)  
**Status:** Draft — pending team review  
**Origin:** Feature request in #the-hatchery, 2026-02-06  

---

## Problem Statement

OpenClaw agents operate across a mix of work and private contexts. Some contexts — executive channels, personal conversations — contain information that must not be shared broadly across the "hive mind." Today, all memories written to Vestige are globally accessible to any agent that queries the service. There is no mechanism to restrict who can read or write specific memories.

We need an **access control layer** (ACL) with **tag-based scoping** so that:
- Memories are tagged at write time based on the source channel
- Tags control who can read and write those memories
- Private contexts remain private; shared contexts remain shared
- The default behavior ("global") preserves backward compatibility

---

## Design

### Core Concept: Tags

Every memory in Vestige gets one or more **tags** that control access. Tags are the atomic unit of the ACL system.

#### Tag Format

Tags follow the pattern `<owner>:<label>`:

```
global              — Special: read/write by anyone (default)
eddie:executive     — Eddie's executive context
eddie:personal      — Eddie's personal memories
anisha:research     — Anisha's research context
team:hatchery       — Shared among hatchery team members
```

- The `global` tag is a special singleton — no owner prefix, universally accessible
- All other tags have an owner (the user who created the tag)
- Tags are unique strings; the `owner:label` convention is enforced at creation time

#### Tag Ownership Rules

| Rule | Description |
|------|-------------|
| **Default tag** | Any memory written without an explicit tag gets `global` |
| **Owner read/write** | A tag owner can always read and write memories with their tags |
| **Global is open** | `global` tagged memories are read/write for everyone |
| **Others need grants** | Non-owners cannot read or write a tag's memories unless explicitly granted |
| **Grants are per-tag** | Tag owners can grant `read`, `write`, or `read+write` to specific users |

### Channel → Tag Mapping (Configuration)

In `openclaw.json`, the vestige plugin configuration maps channels to tags:

```jsonc
{
  "plugins": {
    "vestige": {
      "url": "https://vestige.internal:8000",
      "token": "...",
      "channelTags": {
        // Channel ID → tag(s) assigned to memories from that channel
        "slack:C0ACUTPFSJ3": ["team:hatchery"],
        "slack:D_EDDIE_DM": ["eddie:personal"],
        "signal:eddie-personal": ["eddie:personal"],
        "telegram:exec-group": ["eddie:executive"],
        
        // Channels not listed here default to "global"
      }
    }
  }
}
```

When the plugin sends a write request (ingest/smart_ingest), it looks up the current channel and attaches the corresponding tag(s). If the channel is not in the map, the tag is `global`.

### Tag Database

The Vestige bridge server maintains a lightweight tag registry:

```sql
-- Tag definitions
CREATE TABLE tags (
    tag         TEXT PRIMARY KEY,   -- e.g. "eddie:executive"
    owner       TEXT NOT NULL,      -- e.g. "eddie"
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
);

-- Access grants (who can access tags they don't own)
CREATE TABLE tag_grants (
    tag         TEXT NOT NULL REFERENCES tags(tag),
    grantee     TEXT NOT NULL,      -- user id or "everyone"
    permission  TEXT NOT NULL CHECK (permission IN ('read', 'write', 'readwrite')),
    granted_by  TEXT NOT NULL,
    granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tag, grantee)
);

-- Memory ↔ tag associations
CREATE TABLE memory_tags (
    memory_id   TEXT NOT NULL,      -- Vestige memory identifier
    tag         TEXT NOT NULL REFERENCES tags(tag),
    PRIMARY KEY (memory_id, tag)
);
```

Tags are auto-created on first use (the owner is extracted from the `owner:label` pattern). The `global` tag is seeded at initialization.

---

## Request Flow

### Write Path

```
Agent writes a memory (e.g., vestige_smart_ingest)
  → Plugin resolves current channel → tag(s) from channelTags config
  → Plugin attaches tags + requesting user identity to the HTTP request
  → Bridge checks: can this user WRITE to all specified tags?
    → YES: forward to Vestige MCP, store memory, record tag associations
    → NO:  reject the write entirely (HTTP 403), memory is NOT stored
```

**Critical behavior on write rejection:** If a write comes in for a tag the user cannot write, the memory is **not written at all** — not even to `global`. This prevents information leakage through "fallback" writes.

### Read Path

```
Agent queries memories (e.g., vestige_search)
  → Plugin attaches requesting user identity to the HTTP request
  → Bridge forwards query to Vestige MCP (full search, no filtering yet)
  → Bridge receives candidate memories from Vestige
  → Bridge filters results: only return memories where the user can READ at least one tag
  → Bridge returns filtered results to the agent
```

The full semantic/keyword analysis happens on all memories in Vestige (so relevance ranking is accurate), but the **post-filter** strips out anything the requesting user lacks read access to. This means:

- Users never see memories they shouldn't
- Ranking quality is preserved (the search isn't artificially narrowed)
- The Vestige engine itself remains tag-unaware (ACLs are a bridge concern)

### Identity Resolution

The requesting user is identified by:
1. **`X-User-Id` header** — Set by the OpenClaw plugin based on the session owner
2. **`X-Agent-Id` header** — Existing agent identity header (for audit trail)

The plugin must send `X-User-Id` on every request. The bridge uses this for all ACL checks.

---

## API Changes

### New Endpoints

```
POST /tags                  — Create a tag
GET  /tags                  — List tags (filtered by what the user can see)
GET  /tags/:tag             — Get tag details + grants
POST /tags/:tag/grants      — Grant access to a tag
DELETE /tags/:tag/grants/:grantee — Revoke access

GET  /memories/:id/tags     — List tags on a memory
POST /memories/:id/tags     — Add tags to a memory (requires write on those tags)
DELETE /memories/:id/tags/:tag — Remove a tag from a memory
```

### Modified Endpoints

All existing endpoints gain tag-awareness:

- **`POST /ingest`** and **`POST /smart_ingest`**: Accept a `tags` field (array of strings). If omitted, defaults to `["global"]`. Write is rejected (403) if the user lacks write permission on any specified tag.

- **`POST /search`**: Accepts optional `tags` filter (array of strings) to narrow search scope. Results are always post-filtered by the user's readable tags regardless of whether a filter is specified.

- **`POST /memory`**, **`POST /codebase`**, **`POST /intention`**: Same tag injection and write-check behavior as ingest.

### Request Examples

```bash
# Ingest with tags
curl -X POST http://vestige:8000/smart_ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-User-Id: eddie" \
  -H "X-Agent-Id: tabitha" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Q4 board deck uses the new revenue model",
    "node_type": "fact",
    "tags": ["eddie:executive"]
  }'

# Search with tag filter (only returns memories user can read)
curl -X POST http://vestige:8000/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-User-Id: eddie" \
  -d '{
    "query": "board deck",
    "tags": ["eddie:executive"],
    "mode": "hybrid"
  }'

# Grant read access
curl -X POST http://vestige:8000/tags/eddie:executive/grants \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-User-Id: eddie" \
  -d '{"grantee": "anisha", "permission": "read"}'
```

---

## Plugin Changes

### Channel Tag Resolution

The plugin gains a `resolveChannelTags(channelId: string): string[]` function:

```typescript
function resolveChannelTags(channelId: string): string[] {
  const config = getPluginConfig();
  const tags = config.channelTags?.[channelId];
  return tags ?? ["global"];
}
```

This is called on every write operation to inject the appropriate tags.

### User Identity Injection

The plugin must resolve the current session's owner and inject `X-User-Id` on every request to the bridge:

```typescript
async function callBridge(endpoint: string, body: object): Promise<any> {
  const userId = getCurrentSessionOwner(); // from OpenClaw session context
  const agentId = getAgentIdentity();
  
  return fetch(`${bridgeUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${authToken}`,
      "X-User-Id": userId,
      "X-Agent-Id": agentId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
```

### Tool Registration Updates

The registered tools gain optional `tags` parameters:

- `vestige_ingest(content, node_type, tags?)`
- `vestige_smart_ingest(content, node_type, context?, tags?)`
- `vestige_search(query, mode?, limit?, tags?)`

When tags are not explicitly passed by the agent, the plugin auto-injects them from the channel mapping.

---

## Migration

### Existing Memories

All memories created before this feature are untagged. Migration strategy:

1. **Auto-tag as `global`**: A migration script adds `global` tag entries to `memory_tags` for all existing memories. This preserves current behavior — everything remains accessible to everyone.

2. **Optional re-tagging**: Admins can retroactively tag specific memories via the API if needed (e.g., bulk-tagging memories from a known private channel).

### Backward Compatibility

- Requests without tags default to `global` (existing behavior)
- Requests without `X-User-Id` are treated as anonymous and can only access `global` memories
- The `VESTIGE_ALLOW_ANONYMOUS` flag continues to work as before (but only grants `global` access)

---

## Implementation Phases

### Phase 1: Tag Storage & Write-Path Enforcement
- Add `tags`, `tag_grants`, `memory_tags` tables to the bridge SQLite DB
- Add `tags` field to ingest/smart_ingest endpoints
- Enforce write permission checks on all write operations
- Auto-create tags on first use
- Plugin: inject channel-resolved tags on write
- Plugin: inject `X-User-Id` header
- Migration: tag all existing memories as `global`

### Phase 2: Read-Path Filtering
- Post-filter search results by user's readable tags
- Add `tags` filter parameter to search endpoint
- Plugin: pass through optional tag filters from agent

### Phase 3: Tag Management API
- CRUD endpoints for tags and grants
- Admin UI or CLI for managing grants
- Audit logging for grant changes

### Phase 4: Agent-Level Awareness
- Update agent system prompts to understand tag scoping
- Agents can request specific tag contexts ("search my executive memories")
- Agents can suggest tag assignments for new memories

---

## Security Considerations

- **Write rejection is total**: A failed write-ACL check means the memory is not stored anywhere, not even under a fallback tag. This prevents data leakage.
- **Read filtering is post-search**: The full search runs against all memories for relevance, but results are filtered before returning. This means the *existence* of filtered memories is never revealed to the requester (no count hints, no partial data).
- **Tag owners are derived from the tag string**: The `owner:label` format means ownership is declarative and verifiable. No separate ownership table needed.
- **Grants are explicit**: There is no implicit sharing. Even admins must create explicit grants.
- **Timing safety**: Tag permission checks should use constant-time comparison where possible to prevent timing-based information leakage.

---

## Open Questions

1. **Hierarchical tags?** Should `eddie:*` match all of Eddie's tags, or must each be enumerated?
2. **Team/group grants?** Currently grants are per-user. Should we support granting to groups (e.g., `team:eng`)?
3. **Tag inheritance?** If a memory has multiple tags (`global` + `eddie:executive`), does it appear in both scopes? (Current design: yes)
4. **Revocation behavior?** When a grant is revoked, do existing memories become invisible immediately? (Current design: yes)
5. **Agent vs. user identity?** If Tabitha writes a memory on Eddie's behalf in a private channel, is the owner Eddie (session owner) or Tabitha (agent)? (Current design: Eddie, via `X-User-Id`)
