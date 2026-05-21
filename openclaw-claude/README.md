# openclaw-claude

An OpenClaw plugin that delegates Anthropic model turns to a local
[claude-app-server](https://github.com/sumansid/claude-app-server) process —
the Claude equivalent of the OpenAI Codex App Server.

---

## Architecture

```
OpenClaw (product layer)
  └─► openclaw-claude plugin  (AgentHarness)
        └─► JSON-RPC 2.0 over stdio
              └─► claude-app-server  (npm: claude-app-server)
                    └─► Claude Code CLI  (claude --print --output-format stream-json …)
                          └─► Anthropic Messages API
```

**OpenClaw owns:** channels, memory, persona, session routing, cron, hooks.  
**claude-app-server owns:** the thread lifecycle, the agentic loop, tool execution, session JSONL.

The plugin is thin glue: it spawns `claude-app-server` as a child process,
speaks JSON-RPC 2.0 over stdin/stdout (NDJSON — same protocol shape as the
Codex App Server), and translates results back into the OpenClaw
`AgentHarness` contract.

---

## Why claude-app-server and not a custom HTTP server?

`claude-app-server` is a community-built (MIT) server that already does
exactly what we need — it implements the same JSON-RPC thread/turn protocol
that OpenAI's Codex App Server uses, but over the Claude Code CLI instead.
OpenClaw already knows this protocol well (its Codex extension is a
production client of it). There is no wheel to reinvent.

---

## Prerequisites

### 1. Claude Code CLI

The server wraps `claude` (the Claude Code CLI). Install it:

```bash
npm install -g @anthropic-ai/claude-code
```

Authenticate once:

```bash
claude auth
# or
claude setup-token   # if using an API key
```

### 2. claude-app-server

```bash
npm install -g claude-app-server
```

Verify it starts (Ctrl-C to stop):

```bash
claude-app-server
# ← waits for stdin input; that's correct for stdio mode
```

---

## Installation

### 1. Build the plugin

```bash
cd plugin
npm install
npm run build
```

### 2. Register in openclaw.json

```json
{
  "plugins": {
    "entries": {
      "claude": {
        "path": "/path/to/openclaw-plugins/openclaw-claude/plugin",
        "config": {
          "permissionMode": "acceptEdits"
        }
      }
    }
  }
}
```

Restart OpenClaw. The plugin spawns `claude-app-server` as a child process
on startup and keeps it running for the lifetime of the gateway.

---

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `bin` | string | `"claude-app-server"` | Command/path for the server binary |
| `binArgs` | string[] | `[]` | Extra CLI args to pass on spawn |
| `env` | object | `{}` | Extra env vars injected into the server process |
| `permissionMode` | string | `"default"` | `"default"` / `"acceptEdits"` / `"bypassPermissions"` |
| `priority` | number | `10` | Harness priority (higher wins over PI when both match) |
| `turnTimeoutMs` | number | `600000` | Per-turn hard timeout in ms |

---

## Protocol

The plugin speaks [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over
`stdin`/`stdout` (newline-delimited JSON). The method surface used:

| Method | Direction | Purpose |
|---|---|---|
| `thread/start` | request | Create a new Claude thread for a fresh OpenClaw session |
| `thread/resume` | request | Verify an existing thread is still alive |
| `turn/start` | request | Send the user prompt; returns `turn_id` immediately |
| `turn/interrupt` | request | Abort an in-progress turn |
| `item/progress` | notification | Streaming text delta |
| `item/created` | notification | Finalized item (text block, tool call, tool result) |
| `turn/completed` | notification | Turn finished successfully |
| `turn/error` | notification | Turn failed |

Session continuity: the plugin maintains a `Map<openclawSessionId, threadId>`.
Each new OpenClaw session gets a `thread/start`; subsequent turns in the same
session resume the same thread via `thread/resume` + `turn/start`.

---

## Harness selection

The harness registers for:
- `provider === "anthropic"` in `auto` runtime mode (priority 10 by default)
- Any runtime pinned to `"claude-app-server"` (priority 1010)

It defers to the PI harness for any other provider.
