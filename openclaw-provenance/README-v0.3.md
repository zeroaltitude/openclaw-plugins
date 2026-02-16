# openclaw-provenance

**Content provenance taint tracking and security policy enforcement for OpenClaw agents.**

An OpenClaw plugin that builds per-turn provenance DAGs, tracks trust-level propagation through the agent loop, and enforces declarative security policies with code-based approval — providing defense-in-depth against prompt injection escalation.

## The Problem

LLM agents routinely ingest external content: emails, Slack messages, web pages, shared memory, calendar events. Any of this content can contain adversarial instructions (prompt injection). The agent has no architectural boundary between "instructions from the user" and "text from an email" — both enter the same context window.

Without provenance tracking, a single malicious email can:
1. Instruct the agent to run `exec` commands
2. Send messages on the user's behalf
3. Exfiltrate data via `web_fetch` or `browser`
4. Modify its own configuration via `gateway`
5. Spawn sub-agents to persist across sessions

**This plugin makes the implicit trust boundaries explicit and enforces them.**

### Relevance to the OpenClaw Threat Model

We submitted [the first issue](https://github.com/openclaw/trust) to the `openclaw/trust` repository documenting how workspace files (TOOLS.md, AGENTS.md, etc.) are injected verbatim into the system prompt, creating a credential storage honeypot. Any prompt injection that gains tool access can read these files and exfiltrate secrets.

The [OpenClaw threat model](https://trust.openclaw.ai/threatmodel) identifies 37 threats mapped to MITRE ATLAS. This plugin directly mitigates 8 of them and partially addresses 4 more:

| ATLAS Technique | Threat | Mitigation |
|----------------|--------|------------|
| AML.T0051 | Prompt injection via external content | Taint tracking + tool restriction |
| AML.T0054 | Tool misuse after context poisoning | Execution-layer blocking |
| AML.T0043 | Data exfiltration via tools | Restrict `message`, `browser`, `exec` when tainted |
| AML.T0040 | Agent persistence/replication | Block `sessions_spawn`, `cron` when tainted |
| AML.T0048 | Configuration tampering | `gateway` tool requires approval at all trust levels |
| AML.T0056 | Recursive agent loops | Iteration cap with turn blocking |
| AML.T0052 | Confused deputy attacks | Trust classification prevents privilege escalation |
| AML.T0055 | Social engineering via agent | Block `message` when context contains untrusted content |

**Partially addressed** (plugin reduces impact but does not fully prevent):

| ATLAS Technique | Threat | Partial Mitigation | Gap |
|----------------|--------|-------------------|-----|
| AML.T0051.001 | Indirect prompt injection (T-EXEC-002) | Taint tracking restricts tool escalation after injection | Cannot detect or prevent the injection itself — only limits its blast radius |
| AML.T0043 | Approval prompt manipulation (T-EVADE-003) | Unpredictable 8-char hex codes prevent automated approval bypass | Owner can still be socially engineered into approving a malicious tool call |
| AML.T0009 | Data theft via `web_fetch` (T-EXFIL-001) | `web_fetch` taints context, restricting subsequent dangerous tools | `web_fetch` itself is always allowed (read-only) — data can be exfiltrated via URL parameters in the request |
| AML.T0051.000 | Memory poisoning via prompt injection (T-PERSIST-005) | Memory file write blocking prevents tainted content from persisting to MEMORY.md, SOUL.md, etc. Blocked writes are persisted to `.provenance/blocked-writes/` for review — content is never lost. Owner must `.reset-trust` to commit or review manually. | Vestige memory tool output trust is user-configurable. Users who trust their memory infrastructure should configure vestige tools as "trusted" output taint. |

## Architecture

### Two Independent Axes: Tool Response Trust vs. Tool Call Permission

The plugin tracks two completely independent properties for each tool:

1. **Response trust** (`DEFAULT_TOOL_OUTPUT_TAINTS` in `trust-levels.ts`, configurable via `toolOutputTaints`): What taint level does this tool's **response** introduce into the context? This is a property of the data the tool returns — not whether the tool is safe to invoke.

2. **Call permission** (`DEFAULT_SAFE_TOOLS` / `toolOverrides` in `policy-engine.ts`): Is this tool **allowed to be called** at the current taint level? This is a property of what the tool can *do* — its side effects.

These are orthogonal:

| Tool | Response trust (default) | Call permission (default) | Rationale |
|------|--------------------------|--------------------------|-----------|
| `web_fetch` | `untrusted` | always allowed | Read-only HTTP GET. No side effects. But the response is untrusted web content. |
| `web_search` | `untrusted` | always allowed | Read-only search API. No side effects. Response is untrusted. |
| `read` | `trusted` | always allowed | Read-only file access. Response is local content. |
| `browser` | `untrusted` | blocked when tainted | Can click, submit forms, execute JS on authenticated pages. Response is untrusted. |
| `exec` | `trusted` | blocked when tainted | Arbitrary command execution. Response is trusted but the *action* is dangerous. |
| `message` | `external` | blocked when tainted (except owner DMs) | Sends messages as the owner. Response is external content. Owner DMs always allowed. |
| `vestige_search` | `shared` | always allowed | Read-only memory search. Response is shared cross-agent data. |
| `gateway` | `trusted` | always requires approval | Can disable security plugins. Response is system-level config. |

A tool's response trust determines **how it taints the context for future iterations**. A tool's call permission determines **whether it can be invoked in the current iteration**.

### Tool Output Taint Defaults and Configuration

When a tool returns a response, the plugin looks up the tool's **output taint** — the trust level assigned to the data it produced. This taint propagates into the provenance graph via the high-water mark, potentially restricting tools in subsequent iterations.

#### Default Output Taints

Every tool has a built-in default output taint. Unknown tools default to `untrusted` (see [Unknown Tools](#unknown-tools-secure-by-default)).

| Trust Level | Tools |
|-------------|-------|
| **trusted** | `Read`, `Edit`, `Write`, `exec`, `process`, `tts`, `cron`, `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_history`, `agents_list`, `nodes`, `canvas`, `gateway`, `session_status` |
| **shared** | `vestige_search`, `vestige_smart_ingest`, `vestige_ingest`, `vestige_promote`, `vestige_demote`, `memory_search`, `memory_get` |
| **external** | `message`, `gog`, `image` |
| **untrusted** | `web_fetch`, `web_search`, `browser` |

#### Overriding Output Taints via Config

The `toolOutputTaints` config block lets you override any tool's output taint without modifying code. Overrides are merged with the defaults at plugin startup — specified tools get the override, everything else keeps its default.

```json
{
  "plugins": {
    "entries": {
      "provenance": {
        "config": {
          "toolOutputTaints": {
            "web_fetch": "external",
            "web_search": "external"
          }
        }
      }
    }
  }
}
```

This example reclassifies `web_fetch` and `web_search` output from `untrusted` to `external`. The practical effect: after a `web_fetch`, the session taint escalates to `external` instead of `untrusted`. If your `taintPolicy` treats `external` differently from `untrusted` (e.g., `confirm` vs `restrict`), this changes which tools are blocked and how.

**Use cases:**

- **Internal APIs**: If `web_fetch` is used primarily against trusted internal endpoints, override to `trusted`
- **Curated search**: If `web_search` results are filtered through a trusted proxy, override to `external`
- **Custom tools**: Any tool added by skills or plugins can be classified — unknown tools default to `untrusted`; override to set the appropriate level
- **Stricter classification**: Override a tool *up* in taint (e.g., `exec` → `shared`) if its output comes from multi-tenant infrastructure
- **Vestige as trusted**: If you control your own Vestige instance, override vestige tools to `trusted`

The resolved taint map is logged at startup when overrides are present:
```
[provenance] Tool output taint overrides: {"web_fetch":"external","web_search":"external"}
```

### Trust Levels

Content is classified into four trust levels, ordered from most to least trusted:

| Level | Description | Examples |
|-------|-------------|----------|
| `trusted` | Content from us — system, owner, local tools | System prompt, SOUL.md, owner DMs, file reads, exec output, sub-agents, cron |
| `shared` | Shared/cross-agent data | Vestige memories, sub-agent results from shared memory |
| `external` | Known external sources | Email (Gmail), Slack messages, calendar events, channel messages from non-owners |
| `untrusted` | Unknown/adversarial sources | Web pages (`web_fetch`), `browser` content, unknown webhooks |

The previous six-level model (system → owner → local → shared → external → untrusted) collapsed the top three levels into `trusted` because they all behaved identically — policy was "allow" for all three. The shared/external/untrusted distinction remains meaningful and configurable.

### Three Sources of Taint

A turn's taint level can be escalated by three distinct mechanisms:

1. **Initial trust classification** — determined at turn start from sender/channel metadata
2. **Tool response trust** — determined when a tool returns results (from `DEFAULT_TOOL_OUTPUT_TAINTS`)
3. **History content** — the conversation history node inherits the initial trust classification

Each of these adds nodes to the provenance graph, and each node's trust level feeds into the high-water mark. The rest of this section explains each mechanism in detail.

### Initial Trust: Sender & Channel Classification

When a turn begins, the plugin classifies the **initial trust level** from the metadata OpenClaw provides about who sent the message and what channel it arrived on. This is the `context_assembled` hook, which fires once per turn before any LLM calls.

The classification logic (`classifyInitialTrust()` in `security/index.ts`):

```
1. No messageProvider (cron, heartbeat, system event)     → trusted
2. Sub-agent session (spawnedBy is set)                   → trusted
3. Owner (senderIsOwner=true)                             → trusted
4. Known non-owner sender (senderId present)              → external
5. Unknown sender (no metadata)                           → untrusted
```

This classification sets the trust on the `history` node in the provenance graph. Since the history node is added before any tools run, it establishes the **floor** for the turn's taint — subsequent tool calls can only escalate it further, never reduce it.

#### How OpenClaw channels map to trust levels

OpenClaw supports many communication channels. Here's how each maps to the classification:

| Channel | Scenario | Initial Trust | Rationale |
|---------|----------|---------------|-----------|
| Discord DM | Owner sends a message | `trusted` | `senderIsOwner=true` |
| Discord DM | Non-owner sends a DM | `external` | `senderIsOwner=false`, `senderId` present |
| Discord server channel | Owner sends in #general | `trusted` | `senderIsOwner=true` |
| Discord server channel | Non-owner sends in #general | `external` | Known sender, not the owner |
| Slack DM | Owner sends a message | `trusted` | `senderIsOwner=true` |
| Slack channel | Owner sends in #eng-general | `trusted` | `senderIsOwner=true` |
| Slack channel | Non-owner sends | `external` | Known sender, not the owner |
| Telegram DM | Owner sends | `trusted` | `senderIsOwner=true` |
| Telegram group | Owner sends | `trusted` | `senderIsOwner=true` |
| Telegram group | Non-owner sends | `external` | Known sender, not the owner |
| Signal DM | Owner sends | `trusted` | `senderIsOwner=true` |
| Cron job | Scheduled task fires | `trusted` | No `messageProvider` — internal system event |
| Heartbeat | Periodic check | `trusted` | No `messageProvider` |
| Sub-agent | `sessions_spawn` task | `trusted` | `spawnedBy` is set — parent session authorized this work |
| Webhook | External webhook trigger | `untrusted` | No sender metadata available |

#### Trust classification is producer-based

Trust classification is based on **message producer identity**, not venue. The `groupId` field is irrelevant to taint classification.

**Why owner messages in group chats are "trusted":**

Trust is about WHO produced the message, not WHERE it was sent. If the owner sends a message in a group chat, that triggering message is trusted. If non-owner messages exist in the conversation history, those would have been classified as "external" or "untrusted" in their respective turns, and the session watermark would persist that taint across subsequent turns.

The `.reset-trust` command allows the owner to explicitly trust the entire context after reviewing it.

**How multi-participant conversations are handled:**

When non-owner users send messages in group chats:
1. Those turns are classified as "external" (or "untrusted" for unknown senders)
2. The session watermark is escalated to that taint level
3. The watermark persists across turns, even when the owner sends the next message
4. This prevents prompt injections in earlier messages from gaining elevated privileges

This architecture provides defense-in-depth: producer-based classification for the current turn, plus watermark persistence to track historical taint.

#### Metadata availability

The classification depends on fields exposed by OpenClaw's `PluginHookAgentContext`:

| Field | Source | Available since |
|-------|--------|----------------|
| `messageProvider` | Channel plugin (discord, slack, telegram, etc.) | Always |
| `senderId` | Channel plugin — platform-specific user ID | `feature/extended-security-hooks` branch |
| `senderIsOwner` | Computed from `ownerNumbers` config | `feature/extended-security-hooks` branch |
| `groupId` | Channel plugin — channel/group ID | `feature/extended-security-hooks` branch |
| `spawnedBy` | Agent runner — parent session key | `feature/extended-security-hooks` branch |

Without these fields (e.g., on older OpenClaw versions), the classification falls through to the default: `trusted`. This maintains backward compatibility but provides no sender-based trust differentiation.

### Taint Propagation (High-Water Mark)

Each agent turn maintains a **maximum taint level** (`maxTaint`) — the lowest-trust content seen across all nodes in the turn's provenance graph. The taint is updated every time a node is added to the graph:

```typescript
updateTaint(trust: TrustLevel): void {
    this._maxTaint = minTrust(this._maxTaint, trust);
}
```

When a tool is called, `recordToolCall()` looks up the tool's **response trust** from `DEFAULT_TOOL_OUTPUT_TAINTS` and adds a node with that trust level. This may escalate the turn's `maxTaint`:

```
Turn starts:
  context_assembled → node(trust: trusted)
  history → node(trust: trusted)            maxTaint = trusted

Iteration 1:
  LLM call → node(trust: trusted)          maxTaint = trusted
  Tool: read("file.txt") → node(trust: trusted)  maxTaint = trusted
  [LLM sees file contents in next call]

Iteration 2:
  LLM call → node(trust: trusted)          maxTaint = trusted
  Tool: web_fetch(url) → node(trust: untrusted)  maxTaint = untrusted  ← escalated by web_fetch's response trust
  [LLM sees web content in next call]

Iteration 3:
  LLM call → node(trust: untrusted)        maxTaint = untrusted
  Tool: exec("cmd") → BLOCKED              ← policy evaluation sees maxTaint=untrusted, blocks exec
```

**Key timing detail:** The taint escalation from a tool happens when `recordToolCall()` is invoked in the `after_llm_call` hook — i.e., after the LLM has decided to call the tool and the tool has returned results. The policy enforcement happens in `before_llm_call` on the *next* iteration, when those results are in the context. This means:

- A tool's response taints the context for **subsequent** iterations, not the current one.
- The tool that introduces taint is always allowed to complete (it was evaluated against the *previous* taint level).
- Policy enforcement catches the escalated taint on the next `before_llm_call`.

**Consequence:** If `web_fetch` is called in iteration 1 and returns untrusted content, `exec` is blocked starting in iteration 2. The LLM cannot call both `web_fetch` and `exec` in the same iteration and have `exec` be blocked — the blocking happens one iteration later. This is currently acceptable because the LLM processes tool results sequentially (not in parallel branches).

**Taint never decreases within a turn.** `minTrust()` is a one-way ratchet. If one tool returns untrusted content, the entire remainder of the turn is tainted, even if subsequent tools return trusted content.

The high-water mark is correct for current LLM architectures because the context window is a shared memory space. Once untrusted content enters the context, every subsequent LLM call has access to it — there's no isolation between "the part that read the email" and "the part that runs exec."

A more granular per-branch model would require **agent forks** — branching the context window into isolated execution paths. The provenance DAG we build would support this, but no current agent framework implements it.

### Per-Turn Provenance DAG

The plugin builds a directed acyclic graph for each turn:

```
context_assembled
  ├── node: system_prompt (trust: trusted)
  └── node: history (trust: trusted)
                                            maxTaint: trusted
llm_call_1 (trust: trusted)
  └── tool: web_fetch (trust: untrusted)  ← response trust escalates maxTaint
                                            maxTaint: untrusted
llm_call_2 (trust: untrusted)            ← inherits maxTaint
  └── tool: exec → BLOCKED               ← policy sees maxTaint=untrusted, blocks exec
                                            maxTaint: untrusted
output (trust: untrusted)
```

Currently all DAGs are linear chains (one LLM call → one or more tool calls → next LLM call). The infrastructure supports branching for future agent fork architectures.

### Two-Layer Enforcement (Defense in Depth)

**Layer 1: `before_llm_call` — Tool List Filtering**

Before each LLM call, the plugin evaluates the current taint level against the policy and removes restricted tools from the tool list. The LLM never sees restricted tools and cannot attempt to call them.

**Layer 2: `before_tool_call` — Execution Blocking**

If the LLM somehow names a restricted tool (e.g., from memory of a previous turn), the execution layer blocks the call and returns an error with an approval code. This catches any bypass of Layer 1.

Why both layers? Layer 1 is the primary defense (the LLM can't call what it can't see). Layer 2 is the safety net (defense in depth). In testing, we found cases where the LLM would name tools from prior context even after they were removed from the current tool list.

### Fail-Open Design

All hook handlers are wrapped in try/catch. On error:
- `logger.error(...)` with full stack trace
- Return `undefined` (no modification to the agent's behavior)
- The agent continues operating without taint tracking rather than becoming unresponsive

This is an explicit design choice. An unresponsive agent is worse than an agent operating without taint tracking — if something goes catastrophically wrong and credentials leak, the owner sees it in logs and can rotate. A fail-closed agent can't even report that something is wrong.

Watermark store errors are best-effort. Provenance graph errors are best-effort. The agent always keeps running.

## Policy Model

### Three Modes

| Mode | Behavior |
|------|----------|
| `allow` | No restrictions. Tools available normally. |
| `confirm` | Tools blocked with approval code. Owner can approve per-tool or all. |
| `restrict` | Tools silently removed from tool list. No approval possible. |

### Taint Policy

Maps each trust level to a default mode. Must be **monotonically non-decreasing in strictness** (you can't be more permissive for less-trusted content):

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

The plugin validates monotonicity at startup and auto-corrects violations with warnings.

### Tool Overrides

Per-tool overrides that set the mode directly for specific taint levels. Overrides **replace** the taint-level default (not `strictest()`) — this is critical for safe tools:

```json
{
  "toolOverrides": {
    "gateway": { "*": "confirm" },
    "read": { "*": "allow" },
    "exec": { "external": "restrict", "untrusted": "restrict" }
  }
}
```

Key design decision: `read` with `{ "*": "allow" }` overrides `restrict` back to `allow`. If overrides used `strictest()`, safe tools would be blocked when the taint policy is restrictive — making the agent unable to read files to help the user understand what's happening.

### Default Safe Tools (Call Permission)

These tools have override `{ "*": "allow" }` — they are **allowed to be called** regardless of the current taint level:

`read`, `memory_search`, `memory_get`, `web_fetch`, `web_search`, `image`, `session_status`, `sessions_list`, `sessions_history`, `agents_list`, `vestige_search`, `vestige_promote`, `vestige_demote`

A tool is "safe to call" when it has **no dangerous side effects** — it cannot modify state, send messages, execute commands, or take actions on authenticated services. Being safe to call says nothing about the trust level of the tool's *response*:

| Safe tool | Response trust | Why safe to call | Why response is less trusted |
|-----------|---------------|------------------|------------------------------|
| `read` | `trusted` | Read-only file access | File could contain anything |
| `web_fetch` | `untrusted` | HTTP GET, no side effects | Web pages are adversarial |
| `web_search` | `untrusted` | Search API query | Results are adversarial |
| `vestige_search` | `shared` | Read-only memory query | Cross-agent data, not verified |
| `image` | `external` | Analyze an image | External image content |

The safe tool's response still taints the context via `recordToolCall()`. After a `web_fetch` completes, the turn's `maxTaint` escalates to `untrusted`, and subsequent iterations will restrict dangerous tools. The safe tool itself is never blocked — only tools called *after* its tainted response enters the context.

### The `message` Tool: Owner DM Exception

The `message` tool has a split personality:

- **Sending to the owner in a 1:1 DM** (senderIsOwner=true, no groupId, or target is the owner): **Always allowed**, regardless of taint level. This is equivalent to the agent's normal response — just talking to its owner.
- **Sending to a group channel or another user**: **Follows taint-level default** (confirm/restrict when tainted).

The threat model for `message` is the agent being tricked into sending content *to other people* or *into public channels*. Talking to the owner in their own DM is not a risk — and if `message` gets restricted in a DM, the agent can't even report that something is wrong. That's a fail-closed trap.

### Browser: A Special Case

`browser` is intentionally **NOT** a safe tool. Unlike `web_fetch`, the browser has side effects — it can click buttons, submit forms, execute JavaScript, and take actions on authenticated pages. Its response trust is `untrusted` (same as `web_fetch`), but it is restricted by default when tainted because a prompt injection could direct the agent to take destructive actions via the owner's browser session.

The owner can override this for direct use via `toolOverrides`:

```json
{
  "toolOverrides": {
    "browser": {
      "trusted": "allow",
      "shared": "confirm",
      "external": "confirm",
      "untrusted": "confirm"
    }
  }
}
```

This gives a precise behavior:

```
Iteration 1: maxTaint=trusted
  → browser call permission: allowed (trusted override)
  → browser called, returns page content
  → recordToolCall("browser") adds node with trust=untrusted
  → maxTaint escalates: trusted → untrusted

Iteration 2: maxTaint=untrusted
  → browser call permission: confirm (untrusted override)
  → browser BLOCKED unless approved
  → exec, message, etc. also blocked
```

The first browser call succeeds because it was evaluated against the pre-escalation taint (`trusted`). The second browser call is blocked because the first call's response tainted the context to `untrusted`. An injection in the first page cannot direct a second browser action without owner approval.

### Default Dangerous Tools

`gateway` defaults to `{ trusted: "confirm", shared: "confirm", external: "confirm", untrusted: "confirm" }` — requiring approval even at trusted level, because config changes can disable the security plugin itself.

### Unknown Tools (Secure by Default)

Tools not listed in any defaults list (`DEFAULT_SAFE_TOOLS`, `DEFAULT_TAINT_DEFAULT_TOOLS`, `DEFAULT_DANGEROUS_TOOLS`) or user `toolOverrides` are treated as **unknown** and receive the strictest possible handling on both axes:

- **Output taint**: `untrusted` — an unknown tool's response is assumed adversarial
- **Call permission**: the `untrusted` policy mode (or the current taint-level default, whichever is stricter) — regardless of the session's actual taint level

This prevents **tool rename attacks** where a dangerous tool (e.g., `exec`) is re-registered under an unlisted name to bypass restrictions. It also ensures that new tools added by skills or plugins are automatically restricted until explicitly classified.

To make an unknown tool usable, add it to either:
- `toolOutputTaints` in plugin config (to set its output taint level)
- `toolOverrides` in plugin config (to set its call permission per taint level)
- Or both, depending on your needs

### Memory File Write Protection

When taint is shared, external, or untrusted, `Write` and `Edit` operations targeting memory files (MEMORY.md, AGENTS.md, SOUL.md, HEARTBEAT.md, memory/*.md) are **blocked**. The content is **never lost**:

1. Blocked writes are saved to `.provenance/blocked-writes/` with:
   - Original target path
   - Full content that would have been written
   - Taint level and reason
   - Timestamp
2. The agent tells the user: "I saved this to staging — use `.reset-trust` to commit, or review manually at `.provenance/blocked-writes/`"
3. Blocked writes persist across sessions until explicitly approved or cleaned up

This is the critical persistence defense — preventing tainted content from poisoning future sessions via memory files while never losing the user's work. The `BlockedWriteStore` manages these staged writes on disk.

## Code-Based Approval

When a tool is blocked in `confirm` mode, the plugin generates an 8-character hex approval code:

```
Tool 'exec' is blocked by security policy. Context contains tainted content.
Blocked tools: exec
Approval code: bf619df9 (expires in 120s)
Approve:  .approve exec bf619df9 [minutes]
Approve all:  .approve all bf619df9 [minutes]
```

### Approval Format

```
.approve <tool|all> <8-char-hex-code> [duration-minutes]
```

- **Per-tool**: `.approve exec bf619df9` — approves only `exec`
- **All tools**: `.approve all bf619df9` — approves everything blocked
- **Duration**: `.approve exec bf619df9 30` — approval lasts 30 minutes
- **Turn-scoped** (default): `.approve exec bf619df9` — approval expires when the turn ends

Example interaction:

<img width="814" height="798" alt="image" src="https://github.com/user-attachments/assets/dacd2bc1-48a5-4d1a-9986-86351e6069ed" />

<img width="1046" height="469" alt="Screenshot 2026-02-10 at 15 06 44" src="https://github.com/user-attachments/assets/ca6fbb4b-8203-44c7-af86-d85ace42c183" />

### Why Codes?

A simple `!approve exec` command could be injected by prompt injection in the very content that triggered the restriction. The 8-character hex code is:

1. **Unpredictable** — generated randomly, not derivable from context
2. **Time-limited** — expires after configurable TTL (default: 120s)
3. **Session-scoped** — codes are tied to a specific session
4. **Owner-only** — only messages from the verified owner are processed

An attacker would need to guess an 8-character hex code within the TTL window — 4 billion possibilities in 120 seconds.

## Trust Reset

Sometimes the owner has reviewed tainted content and is satisfied it's safe — they shouldn't need to approve every tool individually for the rest of the turn. The `.reset-trust` command resets the turn's taint level:

```
.reset-trust           # Reset to trusted (full trust, all tools available)
.reset-trust shared    # Reset to shared level
```

When `.reset-trust` is processed:
1. The provenance graph's `maxTaint` is set to the specified level
2. The session watermark is cleared
3. The blocked tools set is cleared
4. Any pending approval codes are cleared
5. All tools become immediately available (subject to normal policy at the new taint level)

### Security

**Owner-only:** `.reset-trust` is only processed when `senderIsOwner=true` in the hook context. Non-owner messages containing `.reset-trust` are ignored and logged as a warning.

**No code required:** Unlike `.approve`, `.reset-trust` does not require an approval code. The rationale: `.approve` uses codes to prevent injection attacks from approving their own tools. `.reset-trust` is a broader statement ("I trust everything in this context now") that only the owner can make. Since it requires verified owner identity rather than a guessable code, it's actually a stronger authentication mechanism.

**Backward compatibility:** When `senderIsOwner` is not available (older OpenClaw versions without extended hook context), `.reset-trust` falls back to allowing the command. In this degraded mode, the approval code on `.approve` provides the security guarantee instead.

### When to use `.reset-trust` vs `.approve`

| Scenario | Use |
|----------|-----|
| One specific tool needs unblocking | `.approve exec <code>` |
| You've reviewed the content and trust it all | `.reset-trust` |
| You want time-limited access to a tool | `.approve exec <code> 30` |
| You want to restore full trust for the rest of the session | `.reset-trust` |
| Content is from a known-safe source that happens to be classified as untrusted | `.reset-trust shared` |

## Session Taint Watermark (Cross-Turn Persistence)

By default, the high-water mark taint resets at the start of each turn. But within a session, tainted content from a previous turn persists in the LLM's conversation history — the agent can still "see" the untrusted web page from three turns ago. Without cross-turn tracking, taint restrictions would silently disappear on the next turn.

The **session taint watermark** solves this. It's a persistent record of the worst taint level seen in a session, stored to disk at `<workspaceDir>/.provenance/watermarks.json`. At the start of each turn, the watermark is loaded and applied to the provenance graph as an inherited taint node — ensuring that restrictions carry forward.

### How It Works

1. When a tool call escalates the turn's taint (e.g., `web_fetch` → `untrusted`), the watermark store records the new level, reason, and timestamp.
2. On the next turn's `context_assembled`, the watermark is loaded from disk and injected as a provenance node. The turn starts at the watermark's taint level (or the initial classification, whichever is stricter).
3. The watermark only escalates — it never decreases on its own within a session.
4. The watermark survives gateway restarts (it's persisted to disk with debounced writes).

### Clearing the Watermark

The watermark is cleared in two scenarios:

**`.reset-trust`** — When the owner issues a `.reset-trust` command, it clears both the in-memory taint and the persistent watermark. The reset is recorded in the watermark's `resetHistory` array for audit purposes.

**`/new` or `/reset`** — When a fresh session starts (detected by `before_agent_start` seeing ≤1 messages), the watermark is automatically cleared and the session is saved normally. A fresh session is a fresh trust boundary — there's no conversation history to inherit taint from.

### Watermark File Format

```json
{
  "version": 1,
  "watermarks": {
    "session:abc123": {
      "level": "untrusted",
      "reason": "web_fetch response",
      "escalatedAt": "2026-02-10T20:15:00.000Z",
      "escalatedBy": "web_fetch",
      "lastImpactedTool": "exec",
      "resetHistory": []
    }
  }
}
```

The file is stored at `<workspaceDir>/.provenance/watermarks.json` and is created automatically on first use.

## Developer Mode

When `developerMode` is enabled in the plugin config, the plugin prepends a taint header to every outbound message. This makes the current taint state visible in the conversation for debugging and development:

```
🟢 [taint: trusted | reason: owner DM | last impacted: none]
Here's what I found...
```

```
🔴 [taint: untrusted | reason: web_fetch response | last impacted: exec]
I can see the page content, but exec is currently blocked.
```

The taint emoji indicates severity:
- 🟢 `trusted` — no restrictions
- 🟡 `shared` — mild restrictions
- 🟠 `external` — moderate restrictions
- 🔴 `untrusted` — significant restrictions

### Enabling Developer Mode

```json
{
  "plugins": {
    "entries": {
      "provenance": {
        "config": {
          "developerMode": true
        }
      }
    }
  }
}
```

Developer mode is for debugging only. It exposes internal taint state in messages, which could leak security metadata to other participants in group chats. **Do not enable in production.**

## Configuration

### Installation

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-provenance"
      ]
    },
    "entries": {
      "provenance": {
        "enabled": true,
        "config": {
          "taintPolicy": {
            "trusted": "allow",
            "shared": "confirm",
            "external": "confirm",
            "untrusted": "confirm"
          },
          "approvalTtlSeconds": 120,
          "toolOverrides": {
            "gateway": { "*": "confirm" }
          }
        }
      }
    }
  },
  "hooks": {
    "internal": {
      "enabled": true
    }
  }
}
```

**Important:** `hooks.internal.enabled: true` is required. Without it, the plugin's hooks are never called.

### Backward Compatibility

Old 6-level `taintPolicy` configs (with `system`, `owner`, `local` keys) are accepted and automatically mapped to the 4-level model:

- `system`, `owner`, `local` keys → mapped to `trusted` (using the most permissive of the three)
- `shared`, `external`, `untrusted` keys → pass through unchanged

A deprecation warning is logged when old-format configs are detected. Old `toolOverrides` with 6-level keys are similarly mapped.

### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `taintPolicy` | object | see below | Mode per trust level |
| `taintPolicy.trusted` | string | `"allow"` | Policy for trusted content (system, owner, local) |
| `taintPolicy.shared` | string | `"confirm"` | Policy for shared/cross-agent data |
| `taintPolicy.external` | string | `"confirm"` | Policy for external sources |
| `taintPolicy.untrusted` | string | `"confirm"` | Policy for untrusted/web content |
| `toolOverrides` | object | `{}` | Per-tool mode overrides |
| `approvalTtlSeconds` | number | `60` | Approval code expiry |
| `maxIterations` | number | `10` | Max agent loop iterations |
| `developerMode` | boolean | `false` | Prepend taint header to outbound messages (debugging) |
| `workspaceDir` | string | `process.cwd()` | Directory for persistent state (`.provenance/`) |
| `toolOutputTaints` | object | `{}` | Per-tool output taint overrides. Key = tool name, value = trust level. Merged with built-in defaults. |

### Example Configurations

**Paranoid** — restrict everything below trusted:
```json
{
  "taintPolicy": {
    "shared": "restrict",
    "external": "restrict",
    "untrusted": "restrict"
  }
}
```

**Permissive** — only confirm for untrusted:
```json
{
  "taintPolicy": {
    "shared": "allow",
    "external": "allow",
    "untrusted": "confirm"
  }
}
```

**Interactive** — confirm for external, restrict untrusted:
```json
{
  "taintPolicy": {
    "external": "confirm",
    "untrusted": "restrict"
  }
}
```

### Build

```bash
cd openclaw-provenance
npm install
npm run build    # TypeScript → dist/
npm test         # vitest
```

### Deploy

After building, restart the gateway to load the plugin:

```bash
systemctl --user restart openclaw-gateway
```

Note: `SIGUSR1` does not reload plugins — a full restart is required.

## Hooks Used

The plugin registers handlers on OpenClaw's internal agent loop hooks:

| Hook | Purpose |
|------|---------|
| `context_assembled` | Start provenance graph, record initial context |
| `before_llm_call` | Evaluate policy, filter tool list, process `.approve` commands |
| `after_llm_call` | Record tool calls, update taint level |
| `before_tool_call` | Execution-layer enforcement (defense in depth), memory file write blocking |
| `loop_iteration_start` | Logging |
| `loop_iteration_end` | Record iteration metadata |
| `before_response_emit` | Seal graph, clear turn-scoped approvals, log summary |

All hook handlers are wrapped in fail-open try/catch — errors are logged but never block the agent.

These hooks require the `feature/extended-security-hooks` branch of OpenClaw (or equivalent core support for internal agent loop hooks).

## Security Theory

### Threat Model

The plugin defends against **indirect prompt injection** — the scenario where an agent processes adversarial content that attempts to hijack its actions. This is distinct from direct prompt injection (where the user themselves provides malicious input).

The key insight is that prompt injection is a **structural problem**, not a detection problem. You cannot reliably detect whether text contains adversarial instructions — but you can track where text came from and restrict what happens after it enters the context.

### Information Flow Control

This is a form of **mandatory access control** applied to LLM agent systems. The trust levels form a lattice, and the taint propagation rule (high-water mark) ensures that information can only flow "downward" — from trusted to less-trusted contexts, never the reverse.

In classic information flow control terms:
- **No read up**: An agent at trust level `shared` cannot read `trusted`-level secrets (enforced by OpenClaw's existing access control)
- **No write down**: Content tainted by `untrusted` sources cannot trigger `trusted`-level actions (enforced by this plugin)

The "no write down" property is the novel contribution. Without it, an untrusted web page can trigger the agent to send messages, run commands, or modify configuration — effectively writing to the owner's authority level.

### Limitations

1. **Taint is conservative**: The high-water mark over-restricts. If an agent reads one untrusted web page and ten local files, the entire turn is tainted as `untrusted`. Per-branch tracking would reduce false positives but requires agent forks.

2. **Trust classification is static**: Tool trust levels are hardcoded. A `web_fetch` to `https://internal-api.company.com` gets the same `untrusted` classification as `https://random-blog.com`. Future work could support URL-based trust rules.

3. **Cross-turn tracking is session-scoped**: The persistent watermark store tracks taint across turns within a session, but taint is cleared on `/new` or `/reset` (fresh session start). If a user starts a new session, inherited taint from the previous session is discarded — even if the LLM's conversation history still contains tainted content from before. This is intentional: a fresh session is a fresh trust boundary.

4. **LLM context is shared**: The fundamental limitation. Until agent frameworks support isolated execution branches (agent forks), the high-water mark is the correct model.

## File Structure

```
openclaw-provenance/
├── openclaw.plugin.json     # Plugin manifest and config schema
├── package.json
├── tsconfig.json
├── README.md                # This file
└── src/
    ├── index.ts             # Plugin entry point (register function)
    └── security/
        ├── index.ts         # Hook registration, enforcement logic, fail-open wrappers
        ├── policy-engine.ts # Policy evaluation, approval integration
        ├── approval-store.ts # Code-based approval state management
        ├── provenance-graph.ts # Per-turn DAG construction
        ├── trust-levels.ts  # 4-level trust definitions and tool classification
        ├── watermark-store.ts # Persistent session taint watermarks (disk-backed)
        ├── blocked-write-store.ts # Persists blocked memory file writes to disk
        ├── SECURITY.md      # Internal security documentation
        └── __tests__/
            └── policy-engine.test.ts  # Tests covering all components
```

## License

MIT

## Authors

Eddie Abrams and Tabitha
