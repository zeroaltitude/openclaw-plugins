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

## Architecture

### Two Independent Axes: Tool Response Trust vs. Tool Call Permission

The plugin tracks two completely independent properties for each tool:

1. **Response trust** (`DEFAULT_TOOL_TRUST` in `trust-levels.ts`): What taint level does this tool's **response** introduce into the context? This is a property of the data the tool returns — not whether the tool is safe to invoke.

2. **Call permission** (`DEFAULT_SAFE_TOOLS` / `toolOverrides` in `policy-engine.ts`): Is this tool **allowed to be called** at the current taint level? This is a property of what the tool can *do* — its side effects.

These are orthogonal:

| Tool | Response trust | Call permission (default) | Rationale |
|------|---------------|--------------------------|-----------|
| `web_fetch` | `untrusted` | always allowed | Read-only HTTP GET. No side effects. But the response is untrusted web content. |
| `web_search` | `untrusted` | always allowed | Read-only search API. No side effects. Response is untrusted. |
| `read` | `local` | always allowed | Read-only file access. Response is local content. |
| `browser` | `untrusted` | blocked when tainted | Can click, submit forms, execute JS on authenticated pages. Response is untrusted. |
| `exec` | `local` | blocked when tainted | Arbitrary command execution. Response is local but the *action* is dangerous. |
| `message` | `external` | blocked when tainted | Sends messages as the owner. Response is external content (channel messages). |
| `vestige_search` | `shared` | always allowed | Read-only memory search. Response is shared cross-agent data. |
| `gateway` | `system` | always requires approval | Can disable security plugins. Response is system-level config. |

A tool's response trust determines **how it taints the context for future iterations**. A tool's call permission determines **whether it can be invoked in the current iteration**.

### Trust Levels

Content is classified into six trust levels, ordered from most to least trusted:

| Level | Description | Examples |
|-------|-------------|----------|
| `system` | Core agent configuration | System prompt, SOUL.md, AGENTS.md |
| `owner` | Direct messages from verified owner | Discord DMs from owner ID |
| `local` | Local tool results | File reads, `exec` output, `git status` |
| `shared` | Shared/cross-agent data | Vestige memories, sub-agent results |
| `external` | Known external sources | Email (Gmail), Slack messages, calendar |
| `untrusted` | Unknown/adversarial sources | Web pages (`web_fetch`), `browser` content |

### Three Sources of Taint

A turn's taint level can be escalated by three distinct mechanisms:

1. **Initial trust classification** — determined at turn start from sender/channel metadata
2. **Tool response trust** — determined when a tool returns results (from `DEFAULT_TOOL_TRUST`)
3. **History content** — the conversation history node inherits the initial trust classification

Each of these adds nodes to the provenance graph, and each node's trust level feeds into the high-water mark. The rest of this section explains each mechanism in detail.

### Initial Trust: Sender & Channel Classification

When a turn begins, the plugin classifies the **initial trust level** from the metadata OpenClaw provides about who sent the message and what channel it arrived on. This is the `context_assembled` hook, which fires once per turn before any LLM calls.

The classification logic (`classifyInitialTrust()` in `security/index.ts`):

```
1. No messageProvider (cron, heartbeat, system event)     → system
2. Sub-agent session (spawnedBy is set)                   → local
3. Owner in DM (senderIsOwner=true, no groupId)           → owner
4. Owner in group chat (senderIsOwner=true, groupId set)  → shared
5. Known non-owner sender (senderId present)              → external
6. Unknown sender (no metadata)                           → untrusted
```

This classification sets the trust on the `history` node in the provenance graph. Since the history node is added before any tools run, it establishes the **floor** for the turn's taint — subsequent tool calls can only escalate it further, never reduce it.

#### How OpenClaw channels map to trust levels

OpenClaw supports many communication channels. Here's how each maps to the classification:

| Channel | Scenario | Initial Trust | Rationale |
|---------|----------|---------------|-----------|
| Discord DM | Owner sends a message | `owner` | `senderIsOwner=true`, no `groupId` |
| Discord DM | Non-owner sends a DM | `external` | `senderIsOwner=false`, `senderId` present |
| Discord server channel | Owner sends in #general | `shared` | `senderIsOwner=true`, but `groupId` is set — other users' messages are in the conversation history |
| Discord server channel | Non-owner sends in #general | `external` | Known sender, not the owner |
| Slack DM | Owner sends a message | `owner` | Same as Discord DM |
| Slack channel | Owner sends in #eng-general | `shared` | Group context contains messages from other users |
| Slack channel | Non-owner sends | `external` | Known sender, not the owner |
| Telegram DM | Owner sends | `owner` | `senderIsOwner=true`, no group |
| Telegram group | Anyone sends | `shared` or `external` | Depends on whether sender is owner |
| Signal DM | Owner sends | `owner` | `senderIsOwner=true` |
| Cron job | Scheduled task fires | `system` | No `messageProvider` — this is an internal system event |
| Heartbeat | Periodic check | `system` | No `messageProvider` |
| Sub-agent | `sessions_spawn` task | `local` | `spawnedBy` is set — parent session authorized this work |
| Webhook | External webhook trigger | `untrusted` | No sender metadata available |

#### Why "owner in group" is `shared`, not `owner`

When the owner sends a message in a group chat (Discord server, Slack channel, Telegram group), the initial trust is `shared` rather than `owner`. This is because the **conversation history** in a group chat contains messages from all participants — not just the owner. The LLM will see those messages in its context window.

Even though the *triggering* message is from the owner, the context also contains:
- Messages from other group members (potentially untrusted)
- Bot messages
- Webhook-delivered content

If we classified this as `owner`, the turn would start with full trust, and a prompt injection embedded in another user's earlier message (already in history) would have unrestricted tool access. By classifying as `shared`, we ensure that group-context turns start with appropriate restrictions.

**Note:** This is conservative. If the owner is in a private channel with only trusted colleagues, `shared` may over-restrict. The owner can adjust this via `taintPolicy.shared` — setting it to `allow` if they trust all participants in their configured channels.

#### Metadata availability

The classification depends on fields exposed by OpenClaw's `PluginHookAgentContext`:

| Field | Source | Available since |
|-------|--------|----------------|
| `messageProvider` | Channel plugin (discord, slack, telegram, etc.) | Always |
| `senderId` | Channel plugin — platform-specific user ID | `feature/extended-security-hooks` branch |
| `senderIsOwner` | Computed from `ownerNumbers` config | `feature/extended-security-hooks` branch |
| `groupId` | Channel plugin — channel/group ID | `feature/extended-security-hooks` branch |
| `spawnedBy` | Agent runner — parent session key | `feature/extended-security-hooks` branch |

Without these fields (e.g., on older OpenClaw versions), the classification falls through to the default: `owner`. This maintains backward compatibility but provides no sender-based trust differentiation.

### Taint Propagation (High-Water Mark)

Each agent turn maintains a **maximum taint level** (`maxTaint`) — the lowest-trust content seen across all nodes in the turn's provenance graph. The taint is updated every time a node is added to the graph:

```typescript
updateTaint(trust: TrustLevel): void {
    this._maxTaint = minTrust(this._maxTaint, trust);
}
```

When a tool is called, `recordToolCall()` looks up the tool's **response trust** from `DEFAULT_TOOL_TRUST` and adds a node with that trust level. This may escalate the turn's `maxTaint`:

```
Turn starts:
  context_assembled → node(trust: system)
  history → node(trust: owner)              maxTaint = owner

Iteration 1:
  LLM call → node(trust: owner)            maxTaint = owner (inherits current maxTaint)
  Tool: read("file.txt") → node(trust: local)    maxTaint = local  ← escalated by read's response trust
  [LLM sees file contents in next call]

Iteration 2:
  LLM call → node(trust: local)            maxTaint = local
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

**Taint never decreases within a turn.** `minTrust()` is a one-way ratchet. If one tool returns untrusted content, the entire remainder of the turn is tainted, even if subsequent tools return local content.

The high-water mark is correct for current LLM architectures because the context window is a shared memory space. Once untrusted content enters the context, every subsequent LLM call has access to it — there's no isolation between "the part that read the email" and "the part that runs exec."

A more granular per-branch model would require **agent forks** — branching the context window into isolated execution paths. The provenance DAG we build would support this, but no current agent framework implements it.

### Per-Turn Provenance DAG

The plugin builds a directed acyclic graph for each turn:

```
context_assembled
  ├── node: system_prompt (trust: system)
  └── node: history (trust: owner)
                                            maxTaint: owner
llm_call_1 (trust: owner)
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
    "system": "allow",
    "owner": "allow",
    "local": "allow",
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
| `read` | `local` | Read-only file access | File could contain anything |
| `web_fetch` | `untrusted` | HTTP GET, no side effects | Web pages are adversarial |
| `web_search` | `untrusted` | Search API query | Results are adversarial |
| `vestige_search` | `shared` | Read-only memory query | Cross-agent data, not verified |
| `image` | `external` | Analyze an image | External image content |

The safe tool's response still taints the context via `recordToolCall()`. After a `web_fetch` completes, the turn's `maxTaint` escalates to `untrusted`, and subsequent iterations will restrict dangerous tools. The safe tool itself is never blocked — only tools called *after* its tainted response enters the context.

### Browser: A Special Case

`browser` is intentionally **NOT** a safe tool. Unlike `web_fetch`, the browser has side effects — it can click buttons, submit forms, execute JavaScript, and take actions on authenticated pages. Its response trust is `untrusted` (same as `web_fetch`), but it is restricted by default when tainted because a prompt injection could direct the agent to take destructive actions via the owner's browser session.

The owner can override this for direct use via `toolOverrides`:

```json
{
  "toolOverrides": {
    "browser": {
      "owner": "allow",
      "local": "allow",
      "shared": "confirm",
      "external": "confirm",
      "untrusted": "confirm"
    }
  }
}
```

This gives a precise behavior:

```
Iteration 1: maxTaint=owner
  → browser call permission: allowed (owner override)
  → browser called, returns page content
  → recordToolCall("browser") adds node with trust=untrusted
  → maxTaint escalates: owner → untrusted

Iteration 2: maxTaint=untrusted
  → browser call permission: confirm (untrusted override)
  → browser BLOCKED unless approved
  → exec, message, etc. also blocked
```

The first browser call succeeds because it was evaluated against the pre-escalation taint (`owner`). The second browser call is blocked because the first call's response tainted the context to `untrusted`. An injection in the first page cannot direct a second browser action without owner approval.

### Default Dangerous Tools

`gateway` defaults to `{ local: "confirm", shared: "confirm", external: "confirm", untrusted: "confirm" }` — requiring approval even at local trust level, because config changes can disable the security plugin itself.

### Unknown Tools

Tools with no override get the taint-level default mode. At `confirm` or `restrict`, unknown tools are blocked by default. This is secure-by-default: new tools added to OpenClaw are automatically restricted in tainted contexts until explicitly overridden.

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

### Why Codes?

A simple `!approve exec` command could be injected by prompt injection in the very content that triggered the restriction. The 8-character hex code is:

1. **Unpredictable** — generated randomly, not derivable from context
2. **Time-limited** — expires after configurable TTL (default: 120s)
3. **Session-scoped** — codes are tied to a specific session
4. **Owner-only** — only messages from the verified owner are processed

An attacker would need to guess an 8-character hex code within the TTL window — 4 billion possibilities in 120 seconds.

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
            "system": "allow",
            "owner": "allow",
            "local": "allow",
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

### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `taintPolicy` | object | see below | Mode per trust level |
| `taintPolicy.system` | string | `"allow"` | Policy for system-level content |
| `taintPolicy.owner` | string | `"allow"` | Policy for owner messages |
| `taintPolicy.local` | string | `"allow"` | Policy for local tool results |
| `taintPolicy.shared` | string | `"confirm"` | Policy for shared/cross-agent data |
| `taintPolicy.external` | string | `"confirm"` | Policy for external sources |
| `taintPolicy.untrusted` | string | `"confirm"` | Policy for untrusted/web content |
| `toolOverrides` | object | `{}` | Per-tool mode overrides |
| `approvalTtlSeconds` | number | `60` | Approval code expiry |
| `maxIterations` | number | `10` | Max agent loop iterations |

### Example Configurations

**Paranoid** — restrict everything below local:
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
npm test         # 58 tests via vitest
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
| `before_tool_call` | Execution-layer enforcement (defense in depth) |
| `loop_iteration_start` | Logging |
| `loop_iteration_end` | Record iteration metadata |
| `before_response_emit` | Seal graph, clear turn-scoped approvals, log summary |

These hooks require the `feature/extended-security-hooks` branch of OpenClaw (or equivalent core support for internal agent loop hooks).

## Security Theory

### Threat Model

The plugin defends against **indirect prompt injection** — the scenario where an agent processes adversarial content that attempts to hijack its actions. This is distinct from direct prompt injection (where the user themselves provides malicious input).

The key insight is that prompt injection is a **structural problem**, not a detection problem. You cannot reliably detect whether text contains adversarial instructions — but you can track where text came from and restrict what happens after it enters the context.

### Information Flow Control

This is a form of **mandatory access control** applied to LLM agent systems. The trust levels form a lattice, and the taint propagation rule (high-water mark) ensures that information can only flow "downward" — from trusted to less-trusted contexts, never the reverse.

In classic information flow control terms:
- **No read up**: An agent at trust level `local` cannot read `system`-level secrets (enforced by OpenClaw's existing access control)
- **No write down**: Content tainted by `untrusted` sources cannot trigger `owner`-level actions (enforced by this plugin)

The "no write down" property is the novel contribution. Without it, an untrusted web page can trigger the agent to send messages, run commands, or modify configuration — effectively writing to the owner's authority level.

### Limitations

1. **Taint is conservative**: The high-water mark over-restricts. If an agent reads one untrusted web page and ten local files, the entire turn is tainted as `untrusted`. Per-branch tracking would reduce false positives but requires agent forks.

2. **Trust classification is static**: Tool trust levels are hardcoded. A `web_fetch` to `https://internal-api.company.com` gets the same `untrusted` classification as `https://random-blog.com`. Future work could support URL-based trust rules.

3. **No cross-turn tracking**: Taint resets each turn. If an agent reads a malicious email in turn 1, turn 2 starts clean (at `owner` trust). The malicious content may still be in the conversation history, but the plugin doesn't track this. Cross-turn taint would require persistent session-level tracking.

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
        ├── index.ts         # Hook registration and enforcement logic
        ├── policy-engine.ts # Policy evaluation, approval integration
        ├── approval-store.ts # Code-based approval state management
        ├── provenance-graph.ts # Per-turn DAG construction
        ├── trust-levels.ts  # Trust level definitions and tool classification
        ├── SECURITY.md      # Internal security documentation
        └── __tests__/
            └── policy-engine.test.ts  # 58 tests covering all components
```

## License

MIT

## Authors

Eddie Abrams and Tabitha
