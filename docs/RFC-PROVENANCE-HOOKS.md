# RFC: Agent Loop Observability Hooks & Content Provenance

**Date:** 2026-02-07
**Status:** Draft — for discussion with OpenClaw maintainers
**Authors:** Eddie Abrams, Tabitha (BigHat Biosciences)
**Target:** OpenClaw core plugin hook system

---

## Summary

OpenClaw's plugin hook system provides coarse lifecycle events (turn start/end,
tool call/result) but misses the **inner agent loop** — the recursive cycle of
LLM calls, tool executions, and context assembly that forms the core of every
agent turn. This RFC proposes extending the hook system with ~6 new hook points
that give plugins full observability into the agent loop, enabling a new class
of plugins: security/provenance, compliance, cost management, and A/B testing —
all without modifying OpenClaw core.

The motivating use case is **content provenance and taint tracking** for prompt
injection defense, but the hooks are general-purpose.

---

## Problem

### Prompt Injection is Structural

LLM agents routinely ingest external content — emails, Slack messages, web
pages, shared memory stores, calendar events. This content enters the context
window alongside system prompts and user instructions, and the LLM cannot
fundamentally distinguish data from instructions. This is the prompt injection
problem.

Current defenses (OpenClaw's `wrapExternalContent()`, `SECURITY NOTICE`
markers, `detectSuspiciousPatterns()`) are **text-level** — they add competing
instructions that raise the bar for attackers but can be subverted by
sufficiently clever injection. They're seatbelts, not walls.

The real defense is **structural**: track where content comes from (provenance),
propagate trust levels through the data flow (taint), and enforce policies at
the runtime level (tool gating, message cancellation) — outside the LLM's
ability to override.

### Plugins Can't See Enough

Today's plugin hooks see:

| Hook | What it sees | What it misses |
|------|-------------|----------------|
| `before_agent_start` | System prompt, initial messages | Nothing about subsequent LLM calls |
| `agent_end` | All messages, success/error | No per-iteration visibility |
| `before_tool_call` | Tool name + params | Not the full context that led to this call |
| `after_tool_call` | Tool result | Not how it'll be used in the next LLM call |
| `tool_result_persist` | Message being saved | Not the accumulated taint state |
| `message_sending` | Outgoing message | Not what influenced its generation |

A security plugin needs to answer: "Given everything this agent has ingested
this turn, should I allow it to execute `exec`, send emails, or access
credentials?" That requires seeing the **full assembled context** before each
LLM call, and the **full set of tool calls** after each LLM response.

---

## Proposal: Extended Hook System

### New Hooks

#### 1. `before_llm_call` — The Critical Hook

Fires before every LLM API call within the agent loop, including recursive
calls after tool execution.

```typescript
type PluginHookBeforeLlmCallEvent = {
  /** The complete message array about to be sent to the LLM */
  messages: AgentMessage[];
  /** The assembled system prompt */
  systemPrompt: string;
  /** Which model is being called */
  model: string;
  /** Agent loop iteration (0 = first call, 1 = after first tool round, ...) */
  iteration: number;
  /** Tools available to the LLM for this call */
  tools: ToolDefinition[];
  /** Approximate token count of the assembled context */
  tokenEstimate?: number;
  /** Session and agent context */
  sessionKey: string;
  agentId?: string;
};

type PluginHookBeforeLlmCallResult = {
  /** Replace the message array (content filtering, taint injection) */
  messages?: AgentMessage[];
  /** Replace or modify the system prompt */
  systemPrompt?: string;
  /** Filter the tool list (remove dangerous tools when context is tainted) */
  tools?: ToolDefinition[];
  /** Abort the entire turn */
  block?: boolean;
  blockReason?: string;
};
```

**Why this matters:** This is the only point where a plugin can see the full
assembled prompt AND modify what the LLM can do. A security plugin can:
- Inspect all message content for taint signals
- Remove `exec`, `message send`, or credential-accessing tools when external
  content is present
- Inject dynamic taint warnings into the system prompt
- Block the call entirely if risk exceeds threshold
- Log the full prompt for compliance audit

#### 2. `after_llm_call` — Response Interception

Fires after receiving the LLM's response but before executing any tool calls.

```typescript
type PluginHookAfterLlmCallEvent = {
  /** The context that was sent */
  messages: AgentMessage[];
  /** The LLM's response message */
  response: AgentMessage;
  /** Tool calls the LLM wants to make */
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** Loop iteration */
  iteration: number;
  /** Model that was called */
  model: string;
  /** API call latency */
  latencyMs: number;
  /** Token usage if available */
  tokenUsage?: { input: number; output: number };
};

type PluginHookAfterLlmCallResult = {
  /** Filter or modify tool calls before execution */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** Block all tool execution (agent will respond with text only) */
  block?: boolean;
  blockReason?: string;
};
```

**Why this matters:** After the LLM decides what to do, but before it happens.
A security plugin can:
- Remove specific tool calls ("LLM wants to `exec rm -rf` after reading an
  untrusted email? Blocked.")
- Detect anomalous behavior (agent suddenly wants to send emails when it
  normally doesn't)
- Log decisions for the provenance graph

#### 3. `context_assembled` — Source Visibility

Fires when the full context (system prompt + history + new messages) is
assembled, before the first LLM call.

```typescript
type PluginHookContextAssembledEvent = {
  /** The system prompt */
  systemPrompt: string;
  /** The full message array */
  messages: AgentMessage[];
  /** Content sources that contributed to this context */
  sources: Array<{
    kind: "system_prompt" | "user_message" | "tool_result" | "compacted_history";
    tool?: string;
    trust: TrustLevel;
    messageIndex: number;
  }>;
  /** Session context */
  sessionKey: string;
  agentId?: string;
};
```

**Why this matters:** This provides the initial "census" of what's in the
context and where it came from, before the agent loop begins iterating. Plugins
can build their initial taint state from this.

#### 4. `loop_iteration_start` / `loop_iteration_end` — Recursion Tracking

```typescript
type PluginHookLoopIterationStartEvent = {
  iteration: number;
  pendingToolResults: number;
  messageCount: number;
  sessionKey: string;
};

type PluginHookLoopIterationEndEvent = {
  iteration: number;
  toolCallsMade: number;
  newMessagesAdded: number;
  willContinue: boolean;  // whether the loop will iterate again
  sessionKey: string;
};
```

**Why this matters:** Plugins can monitor recursion depth, detect runaway loops,
and build per-iteration provenance. A cost plugin can abort expensive turns. A
security plugin can escalate policy strictness as iteration depth increases (more
tool results = more potential taint).

#### 5. `before_response_emit` — Final Gate

Fires when the agent's final response is ready, before delivery to the user.

```typescript
type PluginHookBeforeResponseEmitEvent = {
  /** The response content */
  content: string;
  /** Whether this response was influenced by external content */
  taintedBy?: string[];
  /** Channel it's being sent to */
  channel?: string;
  /** Session context */
  sessionKey: string;
};

type PluginHookBeforeResponseEmitResult = {
  /** Modified content */
  content?: string;
  /** Append a provenance footer */
  appendFooter?: string;
  /** Block emission entirely */
  block?: boolean;
  blockReason?: string;
};
```

**Why this matters:** Last chance to modify or block the response. A security
plugin could append provenance metadata ("This response was informed by 2
external emails and 1 shared memory"). A compliance plugin could redact PII.

---

## Trust Levels

A simple, extensible trust taxonomy:

```typescript
type TrustLevel =
  | "system"      // System prompt, SOUL.md, AGENTS.md — highest trust
  | "owner"       // Direct messages from the verified owner
  | "local"       // Tool results from local operations (file reads, exec)
  | "shared"      // Shared memory (Vestige), other agents' contributions
  | "external"    // Email, Slack, calendar — known sources, not controlled
  | "untrusted";  // Web content, unknown webhooks — lowest trust
```

Trust propagation rule: **a derived artifact inherits the lowest trust of its
inputs.** If a response is derived from an `owner` message and an `external`
email, the response's trust is `external`.

### Tool Trust Classification

Default classifications (configurable per deployment):

| Tool | Default Trust | Rationale |
|------|--------------|-----------|
| `read` (local files) | `local` | Workspace files, version controlled |
| `exec` | `local` | Local commands, but powerful |
| `web_fetch` | `untrusted` | Arbitrary internet content |
| `web_search` | `untrusted` | Search result snippets |
| `vestige_search` | `shared` | Other agents may have ingested anything |
| `message read` (email) | `external` | Sender-controlled content |
| `message read` (slack) | `external` | Other users' content |
| `message send` | N/A (action) | Not a content source — but a policy target |
| `exec` (gog gmail) | `external` | Email content via CLI |

---

## Provenance Graph — Built on Hooks

With the extended hooks, a provenance plugin builds a DAG per turn:

```
message_received ─────────────────────────── owner trust
    │
before_agent_start
    │
context_assembled ────────────────────────── sources tagged
    │
    ├─── loop_iteration_start (#0)
    │        │
    │    before_llm_call ─────────────────── full context visible
    │        │                               can remove tools if tainted
    │        ▼ (API call to LLM)
    │        │
    │    after_llm_call ──────────────────── tool calls visible
    │        │                               can filter calls
    │        ├── before_tool_call (gog gmail)
    │        │       │
    │        │   after_tool_call ──────────── trust: external
    │        │       │
    │        │   tool_result_persist
    │        │
    │        ├── before_tool_call (vestige_search)
    │        │       │
    │        │   after_tool_call ──────────── trust: shared
    │        │
    │    loop_iteration_end (#0)
    │
    ├─── loop_iteration_start (#1)
    │        │
    │    before_llm_call ─────────────────── taint: [external, shared]
    │        │                               → remove exec, message send
    │        ▼ (API call, reduced tool set)
    │        │
    │    after_llm_call ──────────────────── text-only response
    │        │
    │    loop_iteration_end (#1)
    │
before_response_emit ─────────────────────── derived_from: [gmail, vestige]
    │                                        max_taint: external
agent_end ────────────────────────────────── graph finalized + persisted
```

### Graph Schema

```typescript
interface TurnGraph {
  turnId: string;
  sessionKey: string;
  agentId?: string;
  timestamp: number;
  durationMs: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: {
    maxTaint: TrustLevel;
    externalSources: string[];
    toolsBlocked: string[];
    iterationCount: number;
  };
}

interface GraphNode {
  id: string;
  kind: "input" | "system_prompt" | "history" | "llm_call" | "tool_call"
      | "tool_result" | "output" | "policy_decision";
  trust: TrustLevel;
  tool?: string;
  iteration?: number;
  contentHash?: string;     // SHA256 — audit without storing content
  contentPreview?: string;  // first 100 chars, optional, redactable
  blocked?: boolean;        // was this node blocked by policy?
  blockReason?: string;
  metadata?: Record<string, unknown>;
}

interface GraphEdge {
  from: string;
  to: string;
  relation: "triggers" | "produces" | "consumes" | "derives_from" | "blocked_by";
}
```

---

## Security Policies — Built on Provenance

With the graph and hooks, security policies become declarative:

```yaml
# provenance-policy.yaml
policies:
  # If any external content is in context, remove exec tool
  - name: no-exec-when-tainted
    when:
      context_taint_includes: [external, untrusted]
    action:
      remove_tools: [exec]
      
  # If untrusted content is present, block all outgoing messages
  - name: no-send-when-untrusted
    when:
      context_taint_includes: [untrusted]
    action:
      block_tools: [message]
      
  # If recursion depth > 5, abort (runaway loop)
  - name: max-recursion
    when:
      iteration_gte: 5
    action:
      block_turn: true
      reason: "Max recursion depth exceeded"
      
  # Log all turns that touch external content
  - name: audit-external
    when:
      context_taint_includes: [external]
    action:
      log_full_context: true
      persist_graph: true
```

---

## Plugin Ecosystem Enabled

### 1. Security / Provenance Plugin
- Builds per-turn DAG
- Enforces taint-based tool policies
- Blocks exfiltration attempts
- Full audit trail

### 2. Cost Management Plugin
- Tracks token usage per LLM call via `before/after_llm_call`
- Monitors recursion depth via `loop_iteration`
- Enforces per-turn cost budgets
- Alerts on anomalous usage

### 3. Compliance Plugin
- Records full prompts for regulatory audit via `before_llm_call`
- PII detection in `context_assembled`
- Data retention enforcement in `tool_result_persist`
- Redaction in `before_response_emit`

### 4. A/B Testing Plugin
- Swaps models or system prompts in `before_llm_call`
- Measures outcomes in `agent_end`
- Per-iteration metrics via `loop_iteration`

### 5. Observability / Debugging Plugin
- Full trace of every LLM call with timing
- Tool execution waterfall
- Context growth monitoring
- Export to OpenTelemetry / Datadog / etc.

---

## Implementation in OpenClaw Core

### Required Changes

The hooks need to be emitted from the agent loop in
`src/agents/pi-embedded-runner/run/attempt.ts`. The key insertion points:

1. **`context_assembled`** — after `buildSystemPromptReport()` and history
   loading, before the first LLM call

2. **`before_llm_call`** — inside the agent loop, before each call to
   `streamSimple()` or equivalent. Must pass the full `messages` array,
   `systemPrompt`, `tools`, and `iteration` counter. Must respect the return
   value (modified messages, filtered tools, block)

3. **`after_llm_call`** — after the LLM response is received and parsed into
   tool calls, before tool execution begins. Must allow filtering `toolCalls`

4. **`loop_iteration_start/end`** — at the boundaries of the agent loop's
   iteration (likely in `@mariozechner/pi-agent-core`'s `AgentLoop`)

5. **`before_response_emit`** — after the final iteration, before the response
   is sent to the channel adapter

### Scope

- **Hook definitions:** ~100 lines of new types in `src/plugins/types.ts`
- **Hook emissions:** ~50 lines of new code in `attempt.ts` (or the agent loop
  abstraction)
- **Hook dispatch:** Existing `PluginHookRegistration` infrastructure handles
  dispatch; just add new hook names to the union type
- **No breaking changes:** All new hooks are additive; existing plugins
  unaffected

### Performance Consideration

`before_llm_call` passes the full message array to every registered handler.
For most deployments (0-2 plugins registered on this hook), this is negligible.
For deployments with many plugins, the hook dispatch should short-circuit if no
handlers are registered.

The hook should **not** deep-copy the messages array — pass by reference and
trust plugins not to mutate in place (or document that mutations are the
mechanism for modification). If a plugin returns a modified `messages` array,
that replaces the original.

---

## Alternatives Considered

### A. Plugin-only (no core changes)

Use existing hooks + shadow state in the plugin to reconstruct the graph.
**Rejected:** `before_tool_call` doesn't see the full context, can't modify
the tool list, and can't intercept LLM calls. The resulting graph has gaps
and the plugin can't enforce policies at the right points.

### B. Middleware in `convertToLlm`

Intercept at the message conversion layer. **Partially viable:** sees the
assembled messages but can't modify tools, can't intercept tool calls after
the LLM response, and requires monkey-patching a core function rather than
using the plugin API.

### C. Fork OpenClaw

Add the hooks in a fork. **Rejected:** maintenance burden, diverges from
upstream, benefits are not shared with the community.

### D. Full taint system in core

Add `TaintedContent` wrappers to every `AgentMessage` in core.
**Too invasive:** requires changing the message format, session persistence,
compaction, and every tool. The hook approach achieves the same security
properties without touching the data model.

---

## Open Questions

1. **Hook ordering:** If multiple plugins register `before_llm_call`, what
   order do they run? The existing `priority` field on hook registrations
   handles this, but should modifications compose (plugin A removes `exec`,
   plugin B removes `message` → both removed)?

2. **Performance budget:** Should there be a timeout on `before_llm_call`
   handlers? A slow plugin could add latency to every LLM call.

3. **Message immutability:** Should the messages array be passed as readonly
   with explicit return for modifications, or allow in-place mutation?

4. **Agent loop abstraction:** The inner loop lives in
   `@mariozechner/pi-agent-core`. Hook emissions may need to be added there
   rather than in OpenClaw's `attempt.ts`. This may require coordination with
   the pi-agent-core maintainer.

5. **Backward compatibility of `before_tool_call`:** The existing hook sees
   tool name + params. Should it also see the current taint state? Or should
   plugins use `after_llm_call` for taint-aware decisions?

6. **Graph persistence:** Where should provenance graphs be stored? Options:
   alongside session files, in a separate SQLite DB, or emitted as events for
   external consumption.

---

## Next Steps

1. Post as GitHub Discussion on `openclaw/openclaw` for maintainer feedback
2. If directionally approved, submit PR adding hook type definitions
3. Build reference implementation: provenance plugin using the new hooks
4. Document hook contracts and publish plugin development guide

---

## Related Work

- OpenClaw `src/security/external-content.ts` — existing text-level taint markers
- OpenClaw `src/plugins/types.ts` — existing hook system
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — LLM01: Prompt Injection
- Anthropic's constitutional AI approach to instruction hierarchy
- Google's Gemini "grounding" metadata on search results
- Data lineage systems in data engineering (Apache Atlas, OpenLineage)
