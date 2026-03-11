# OpenClaw Vestige Security Plugin — Internal Reference

## Overview

The security plugin builds a **provenance graph** for every agent turn, tracking data flow and trust levels through the agent loop. It uses this graph to enforce configurable security policies that prevent prompt injection attacks from escalating into dangerous actions.

The core insight: if an agent reads untrusted content (email, web pages, Slack messages), any subsequent tool calls happen in a tainted context. The plugin tracks this taint and restricts dangerous tools accordingly.

## Trust Levels

Content is classified into four trust levels, ordered from most to least trusted:

| Level | Description | Examples |
|-------|-------------|----------|
| **trusted** | Content from us — system, owner, local tools | System prompt, SOUL.md, owner DMs, file reads, exec output, vestige memory |
| **shared** | Shared/cross-agent data | Cross-agent shared memory (configurable — vestige defaults to trusted) |
| **external** | Known external sources, not user-controlled | Email (Gmail), Slack messages, calendar events |
| **untrusted** | Unknown or adversarial sources | Web pages (web_fetch), browser content, unknown webhooks |

The previous six-level model (system → owner → local → shared → external → untrusted) collapsed the top three into `trusted` because they all behaved identically.

## Taint Evaluation Architecture

### Three Atomic Primitives

1. **Evaluate** (`after_tool_call`): After a tool executes and returns results, compute the effective trust from tool output taint + URI classification. Call `graph.recordToolCall()` — the ONLY place taint escalates.

2. **Block** (`after_llm_call` batch gate + `before_tool_call` execution gate): Before tools execute, check if they are permitted at the current established taint level. Filter blocked tools from the batch.

3. **Reset/Approve** (`context_assembled`): Process `.reset-trust` and `.approve` commands from the verified owner.

### Observed vs. Predicted Taint

Taint evaluation uses **observed** output — it happens in `after_tool_call` after the tool has executed and returned results. This is critical:

- **Old model (predictive):** `after_llm_call` evaluated taint before tools executed, based on what the LLM *proposed* to call. This caused false positive blocking of same-batch tools and phantom taint in watermarks when tools never actually executed.
- **New model (observed):** `after_tool_call` evaluates taint after execution, based on what actually happened. Taint only escalates when tainted content actually enters the context.

### Parallel Batch Correctness

When the LLM proposes multiple tools in a batch (e.g., `[web_fetch, exec]`), they execute concurrently. If `web_fetch` and `exec` both pass the gate at the current taint, they may run in parallel. This is **correct behavior**:

- If `exec` completes before `web_fetch`'s untrusted output is returned, exec operated on a context that genuinely did not contain the tainted content. You can't be tainted by content that doesn't exist yet.
- After both complete, `after_tool_call` records the taint from `web_fetch`, and the *next* batch will see the escalated taint and block `exec`.

Within a batch: enforcement is best-effort (race between completions).
Across batches: enforcement is deterministic (gate reads updated `maxTaint`).

### Hook Responsibilities

| Hook | Taint Role |
|------|------------|
| `context_assembled` | Load watermark, classify initial trust, process `.reset-trust` |
| `before_llm_call` | Filter tool list based on current `maxTaint`, process `.approve` |
| `after_llm_call` | Log proposed tools (diagnostic), batch gate: pre-filter blocked tools |
| `before_tool_call` | Execution gate: defense-in-depth re-check, memory file write blocking |
| `after_tool_call` | **PRIMARY taint evaluation**: `recordToolCall()`, escalate `maxTaint` |
| `before_response_emit` | Flush watermark to disk, seal graph |

## Policy Modes

| Mode | Behavior |
|------|----------|
| `allow` | No restrictions. Tools available normally. |
| `confirm` | Tools blocked until owner approves (`.approve <tool>` or `.approve all`). |
| `restrict` | Tools silently removed from tool list. No approval possible — use `.reset-trust`. |

### Taint Policy

Maps each trust level to a mode. Must be monotonically non-decreasing in strictness:

```json
{
  "taintPolicy": {
    "trusted": "allow",
    "shared": "confirm",
    "external": "confirm",
    "untrusted": "confirm"
  }
}
```

## Default Tool Classifications

### Output Taint (what trust level a tool's response introduces)

| Trust Level | Tools |
|-------------|-------|
| **trusted** | `Read`, `Edit`, `Write`, `exec`, `process`, `tts`, `cron`, `sessions_*`, `agents_list`, `canvas`, `gateway`, `session_status`, all `vestige_*`, `memory_*` |
| **external** | `message`, `gog`, `image` |
| **untrusted** | `web_fetch`, `web_search`, `browser` |

Unknown tools default to `untrusted`.

### Call Permission (whether a tool can be invoked at current taint)

Safe tools (always allowed): `read`, `web_fetch`, `web_search`, `image`, `session_status`, `sessions_list`, `sessions_history`, `agents_list`, `vestige_search`, `vestige_promote`, `vestige_demote`, `memory_search`, `memory_get`

Dangerous tools (blocked when tainted): `exec`, `message` (except owner DMs), `browser`, `sessions_spawn`, `cron`

Always-confirm: `gateway`

## URI Trust Classification

Tool output trust can be overridden on a per-URL basis via `uriTrust` config patterns. This allows fine-grained distinctions like treating `web_fetch` to internal APIs as trusted while keeping external URLs as untrusted.

URI trust is evaluated in `after_tool_call` alongside tool output taint. If a URI pattern matches, it overrides the tool's default trust level.

## Watermark Persistence

The session taint watermark persists the worst taint seen across turns within a session. Stored at `<workspaceDir>/.provenance/watermarks.json`. Cleared by `.reset-trust` or fresh session start.

## Fail-Open Design

All hook handlers are wrapped in try/catch. On error: log and return undefined (no modification). The agent continues operating without taint tracking rather than becoming unresponsive.
