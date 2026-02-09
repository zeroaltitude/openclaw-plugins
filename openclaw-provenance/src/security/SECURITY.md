# OpenClaw Vestige Security Plugin

## Overview

The security plugin builds a **provenance graph** for every agent turn, tracking data flow and trust levels through the agent loop. It uses this graph to enforce configurable security policies that prevent prompt injection attacks from escalating into dangerous actions.

The core insight: if an agent reads untrusted content (email, web pages, Slack messages), any subsequent tool calls happen in a tainted context. The plugin tracks this taint and restricts dangerous tools accordingly.

## Trust Levels

Content is classified into six trust levels, ordered from most to least trusted:

| Level | Description | Examples |
|-------|-------------|----------|
| **system** | Core agent configuration | System prompt, SOUL.md, AGENTS.md |
| **owner** | Direct messages from the verified owner | Discord DMs, direct chat |
| **local** | Tool results from local operations | File reads, exec output, git status |
| **shared** | Shared memory and agent contributions | Vestige memories, cross-agent data |
| **external** | Known external sources, not user-controlled | Email (Gmail), Slack messages, calendar events |
| **untrusted** | Unknown or adversarial sources | Web pages (web_fetch), browser content, unknown webhooks |

Trust propagates downward: if an LLM call consumes external content and then makes a tool call, that tool call's results inherit the "external" taint level (or worse).

## Taint Propagation

The plugin builds a directed acyclic graph (DAG) for each agent turn:

1. **Context assembled** → root node created with trust from system prompt + message history
2. **LLM call** → node inherits trust from all inputs (messages, prior tool results)
3. **Tool call** → node gets trust from the tool's classification (e.g., `web_fetch` = untrusted)
4. **Tool result** → feeds back into next LLM call, propagating its trust level

The graph's **maxTaint** is the lowest trust level seen across all nodes — this is what policies evaluate against.

### Example Flow

```
User asks: "Read my latest email and run the setup script"

1. context_assembled → trust: owner (direct user message)
2. LLM call #1 → decides to read email
3. Tool: gog gmail → trust: external (email content)
4. LLM call #2 → taint now "external" (consumed email content)
5. Tool: exec → BLOCKED by policy (exec disabled when external content present)
```

## Policy Modes

Each trust level can be configured with one of four policy modes:

### allow

No restrictions applied. Policies are skipped entirely for content at this trust level. Use for trusted content where you want maximum flexibility.

### deny

Turn is **blocked entirely** if content at this trust level is detected. The agent receives an error and cannot proceed. Use for content that should never be processed.

### restrict (default for shared/external/untrusted)

Dangerous tools are **automatically removed** from the agent's tool list based on declarative policies. The agent never sees the restricted tools and cannot call them.

Default restrictions:
- **External content** → `exec` removed
- **Untrusted content** → `exec` + `message` removed
- **10+ iterations** → turn blocked entirely (recursion guard)

### confirm

Like `restrict`, but with **interactive approval**. Tools are initially restricted, but the user can grant per-session overrides:

1. Tools are restricted (same as `restrict` mode)
2. A **prominent warning** is logged showing which tools were restricted and why
3. The agent's system prompt is annotated with the restriction notice
4. User can approve individual tools: `!approve exec`
5. Or approve all restricted tools: `!approve all`
6. Approvals persist for the remainder of the session

This mode is ideal when you want security guardrails but also need the flexibility to override them on a case-by-case basis.

#### Confirm Flow Example

```
Turn 1: Agent reads a web page (untrusted content)
  → exec and message restricted
  → Warning: "⚠️ SECURITY: Tools restricted due to untrusted content"

Turn 2: User says "!approve exec"
  → exec re-enabled for this session
  → message still restricted

Turn 3: Agent can now use exec freely for the rest of the session
```

## Configuration

Configuration is set in `openclaw.plugin.json` or passed programmatically:

```json
{
  "taintPolicy": {
    "system": "allow",
    "owner": "allow",
    "local": "allow",
    "shared": "restrict",
    "external": "confirm",
    "untrusted": "restrict"
  }
}
```

### Per-Mode Configuration Examples

**Paranoid mode** — confirm everything below local:
```json
{
  "taintPolicy": {
    "shared": "confirm",
    "external": "confirm",
    "untrusted": "deny"
  }
}
```

**Permissive mode** — only restrict untrusted:
```json
{
  "taintPolicy": {
    "shared": "allow",
    "external": "allow",
    "untrusted": "restrict"
  }
}
```

**Interactive mode** — confirm for external, restrict untrusted:
```json
{
  "taintPolicy": {
    "external": "confirm",
    "untrusted": "restrict"
  }
}
```

## Provenance Graph

Each turn produces a DAG with the following node types:

- **input** — Initial context (system prompt, message history)
- **system_prompt** — The system prompt content
- **history** — Message history
- **llm_call** — An LLM inference call
- **tool_call** — A tool invocation
- **tool_result** — The result returned by a tool
- **output** — The final agent response
- **policy_decision** — A security policy action (tool blocked, turn blocked)

Edges represent data flow relationships:
- **triggers** — One node caused another (e.g., LLM call triggers tool call)
- **produces** — A node produced output (e.g., tool call produces tool result)
- **consumes** — A node consumed input (e.g., LLM call consumes tool results)
- **derives_from** — Trust derivation
- **blocked_by** — A policy blocked a tool or turn

## Debug Logging

The plugin logs structured provenance information with the prefix `[provenance:<session>]`:

```
[provenance:main] ── Turn Start ──
[provenance:main]   Messages: 12 | System prompt: 4521 chars
[provenance:main] ── LLM Call (iteration 0) ──
[provenance:main]   Accumulated taint: external (policy: confirm)
[provenance:main]   Tools available: 8 | Tools removed by policy: exec
[provenance:main]   Graph: 5 nodes, 4 edges
[provenance:main] ⚠️ SECURITY: Tools restricted due to external content in context.
[provenance:main]   Restricted: exec
[provenance:main]   Approve with: !approve <tool> or !approve all
```

Key things to look for:
- **Accumulated taint** — Shows the current worst-case trust level
- **Tools removed by policy** — Which tools were restricted and why
- **⚠️ SECURITY** — Confirm-mode warnings requiring user action
- **✅** — Approval confirmations
- **Turn BLOCKED** — Deny-mode or recursion blocks

## Default Policies

Three policies are built in:

1. **no-exec-when-external** — Removes `exec` when context contains external or untrusted content. Prevents prompt injection from executing arbitrary commands.

2. **no-send-when-untrusted** — Blocks `message` when context contains untrusted content. Prevents prompt injection from sending messages on the user's behalf.

3. **max-recursion** — Blocks the turn entirely after 10 iterations. Prevents infinite loops from consuming resources.

Custom policies can be added via the `policies` config option.

## Realistic Scenarios

### Email → Command Execution

1. User: "Check my email and if there's a deploy request, run `deploy.sh`"
2. Agent reads email via `gog gmail` → context tainted as **external**
3. Agent tries to call `exec` → **blocked** (or pending approval in confirm mode)
4. In confirm mode: user says `!approve exec` → agent can now run the deploy

### Web Browsing → Messaging

1. User: "Summarize this article and post it to #general"
2. Agent fetches web page via `web_fetch` → context tainted as **untrusted**
3. Agent tries to call `message` → **blocked** (untrusted content can't send messages)
4. Agent can still summarize and present to user; user can copy-paste manually

### Vestige Memory → Tool Use

1. Agent searches Vestige for context → context tainted as **shared**
2. With default config (shared: "restrict"), policies are evaluated
3. Since shared content doesn't trigger the external/untrusted policies, no tools are removed
4. Agent proceeds normally — shared memory is trusted enough for most operations

### Multi-Turn Session with Approvals

1. Turn 1: Agent reads Slack messages → external taint → exec restricted
2. Turn 2: User says `!approve exec` → exec re-enabled for session
3. Turn 3: Agent reads a web page → untrusted taint → message now also restricted
4. Turn 4: User says `!approve all` → all tools re-enabled for session
5. All subsequent turns in this session: no restrictions (wildcard approval)
