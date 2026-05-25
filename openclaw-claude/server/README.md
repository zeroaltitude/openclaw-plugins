# @zeroaltitude/openclaw-claude-bridge

JSON-RPC 2.0 server over stdio that exposes Anthropic Claude via the
codex-app-server protocol shape. Lets [OpenClaw](https://docs.openclaw.ai)
drive Claude turns through the same harness pattern it uses for OpenAI
Codex (`@openai/codex`).

> **Fork-preview package.** Published under `@zeroaltitude` while the
> bridge lives on a `zeroaltitude/openclaw` fork of the upstream
> OpenClaw repo, in branch
> [feat/claude-app-server-extension](https://github.com/zeroaltitude/openclaw/tree/feat/claude-app-server-extension).
> Expected to migrate to `@openclaw/openclaw-claude-bridge` once
> upstream OpenClaw maintainers merge the PR and publish under the
> `@openclaw` scope.

## Install

```sh
npm install -g @zeroaltitude/openclaw-claude-bridge
```

Or as a dependency of the `@openclaw/claude` bridge plugin (the
extension spawns the binary on PATH; a global install or a local install
in the same project both work).

After install, the binary `openclaw-claude-bridge` is on PATH and ready
to be spawned by the OpenClaw extension.

## What it does

The server wraps [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
behind the codex-app-server JSON-RPC protocol. Inbound RPC methods the
server handles:

- `initialize`
- `thread/start` — create a fresh Claude thread with developer
  instructions + projected OpenClaw dynamic tools
- `thread/resume` — patch cwd/approvalPolicy/developerInstructions
  in-place; falls back to thread-not-found gracefully
- `thread/fork` — branches a thread; the bridge calls this when the dynamic-tool catalog changes mid-session to preserve transcript continuity while adopting the new catalog (tested in `tests/thread-fork.test.ts`)
- `thread/inject-items` — inject items into an existing thread
- `thread/unsubscribe`
- `turn/start` — run one turn, streaming `item/started`/`item/completed`
  and assistant/reasoning deltas
- `turn/interrupt`, `turn/steer`
- `model/list`

Server→client requests:

- `item/tool/call` — dispatched to the OpenClaw dynamic-tool bridge
- approval requests (command, file) — routed through OpenClaw's
  `BeforeToolCall` hook chain

## How it relates to the OpenClaw extension

The in-tree extension lives in `extensions/claude/src/app-server/` in the
OpenClaw fork and is what spawns this server. Two-piece architecture:

| Component | Where | Package |
|---|---|---|
| In-tree client bridge (ships with OpenClaw) | `zeroaltitude/openclaw` fork | `@openclaw/claude` (bundled extension) |
| **JSON-RPC server (this package)** | `openclaw/openclaw-plugins/openclaw-claude/server/` | `@zeroaltitude/openclaw-claude-bridge` |

The extension's `src/app-server/` directory mirrors the codex
extension's directory layout — it implements the *client side* of the
codex-app-server protocol. The actual server is this separate binary.

> A `plugin/` directory previously held a redundant, never-published
> mirror of the in-tree bridge. It was removed on 2026-05-23; the
> in-tree bridge is the source of truth.

## Server-side features

- **Rate-limit surfacing** (`src/rate-limits.ts`): parses Anthropic 429
  bucket headers + retry-after, folds into the user-visible error
  message.
- **Image payload sanitizer** (`src/image-payload-sanitizer.ts`):
  pre-flight validates content blocks against Anthropic's
  5 MB / 100-images-per-request / allowed-media-types limits before
  hitting the API. Rejected payloads become explicit text notes.
- **Plugin inventory + thread config** (`src/plugin-inventory.ts` +
  `src/plugin-thread-config.ts`): fingerprint the active dynamic-tool
  catalog per thread so resume can detect drift.
- **Approval bridge** (`src/approval-bridge.ts`): routes Claude command
  and file approval requests through the bridge's `BeforeToolCall`
  hook chain.

## State directory

The server persists thread metadata + SDK session JSONLs under
`~/.openclaw/state/claude-bridge/threads/<threadId>/`. The directory
is created on first thread start; override with
`OPENCLAW_CLAUDE_BRIDGE_STATE_ROOT`.

### Legacy state migration

Versions ≤ 0.1.0 of this package were published as
`@zeroaltitude/claude-app-server` and persisted state under
`~/.openclaw/state/claude-app-server/`. On first startup, version 0.2.0+
auto-migrates the legacy directory to the new path if the new one does
not yet exist. Both directories existing simultaneously is treated as a
manual-resolution case (the server logs a warning and proceeds without
migrating).

## Environment variables

- `OPENCLAW_CLAUDE_BRIDGE_STATE_ROOT` — override the state directory.
- `OPENCLAW_CLAUDE_BRIDGE_VALIDATE=1` — force outbound-payload schema
  validation in production builds.
- `OPENCLAW_CLAUDE_BRIDGE_DISALLOWED_TOOLS` — comma-separated list of
  native Claude tool names to disallow per process (extension/plugin
  policy is merged on top per thread).
- `OPENCLAW_CLAUDE_BRIDGE_DISABLE_SUBAGENT_ALIAS=1` — disable the
  default Task↔Agent alias used by the inline-sync subagent path.
- `OPENCLAW_CLAUDE_BRIDGE_ALLOW_ALL=1` — server-wide operator override
  that auto-approves every command/file request. Intended for
  controlled environments only.

## Development

```sh
npm install
npm run build
npm test            # 96 tests
node bin/openclaw-claude-bridge.mjs  # run the server directly
```

Tests live in `tests/`; protocol-schema fixtures in
`src/protocol-schemas/`. Run a single test file with
`npx vitest run tests/<file>.test.ts`.

## License

MIT — Edward Abrams 2026.
