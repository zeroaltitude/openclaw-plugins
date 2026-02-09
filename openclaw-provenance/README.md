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

### Taint Propagation (High-Water Mark)

Each agent turn maintains a **maximum taint level** — the lowest-trust content seen anywhere in the turn. This is a conservative model:

```
Turn starts at: owner (user sent a message)
Agent calls read() → taint: local (file content entered context)
Agent calls web_fetch() → taint: untrusted (web content entered context)
Agent calls exec() → still untrusted (taint never decreases within a turn)
```

The high-water mark is correct for current LLM architectures because the context window is a shared memory space. Once untrusted content enters the context, every subsequent LLM call has access to it — there's no isolation between "the part that read the email" and "the part that runs exec."

A more granular per-branch model would require **agent forks** — branching the context window into isolated execution paths. The provenance DAG we build would support this, but no current agent framework implements it.

### Per-Turn Provenance DAG

The plugin builds a directed acyclic graph for each turn:

```
context_assembled (owner)
    │
    ▼
llm_call_1 (owner)
    │
    ├── tool: web_fetch (untrusted)     ← taint escalates here
    │
    ▼
llm_call_2 (untrusted)                 ← inherits worst taint
    │
    ├── tool: exec → BLOCKED            ← policy enforcement
    │
    ▼
output (untrusted)
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

### Default Safe Tools

These tools are always `{ "*": "allow" }` regardless of taint level:

`read`, `memory_search`, `memory_get`, `web_fetch`, `web_search`, `image`, `session_status`, `sessions_list`, `sessions_history`, `agents_list`, `vestige_search`, `vestige_promote`, `vestige_demote`

Rationale: these are read-only or observability tools. Blocking them when tainted would prevent the agent from doing useful work (reading files, searching memory) without creating new attack surface.

**Important distinction — tool call safety vs. response trust:**

A tool being "safe to call" is different from its response being "trusted." `web_fetch` and `web_search` are safe to *call* (read-only, no side effects), but their *responses* introduce `untrusted` taint into the context. The taint doesn't restrict the tool that introduced it — it restricts what happens *after*:

Note: `browser` is intentionally NOT a safe tool despite being a taint source. Unlike `web_fetch`, the browser can take *actions* — clicking buttons, submitting forms, executing JavaScript — on authenticated pages. A prompt injection could direct the agent to delete repos, approve PRs, or post content using the owner's browser session. It stays in confirm/restrict at elevated taint levels.

```
Iteration 1: taint=owner → browser allowed (safe tool) → page content enters context
Iteration 2: taint=untrusted (from browser response) → exec blocked, message blocked
```

This correctly models the threat: the danger isn't in reading a web page, it's in what the LLM does after adversarial content enters its context window.

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

Eddie Abrams and Tabitha — BigHat Biosciences
