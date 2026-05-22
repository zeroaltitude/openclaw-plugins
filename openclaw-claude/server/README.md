# @zeroaltitude/claude-app-server

JSON-RPC 2.0 server over stdio that exposes Anthropic Claude via the
codex-app-server protocol shape. Lets [OpenClaw](https://docs.openclaw.ai)
drive Claude turns through the same harness pattern it uses for OpenAI
Codex (`@openai/codex`).

> **Fork-preview package.** Published under `@zeroaltitude` while the
> bridge ships under `@openclaw/claude` in the upstream OpenClaw fork at
> [openclaw/openclaw#feat/claude-app-server-extension](https://github.com/openclaw/openclaw).
> Expected to migrate to `@openclaw/claude-app-server` when the upstream
> PR lands and OpenClaw maintainers publish under the `@openclaw` scope.

## Install

```sh
npm install -g @zeroaltitude/claude-app-server
```

Or as a dependency of the `@openclaw/claude` bridge plugin (the bridge
spawns the binary on PATH; a global install or a local install in the
same project both work).

After install, the binary `openclaw-claude-app-server` is on PATH and
ready to be spawned by the bridge.

## What it does

The server wraps [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
behind the codex app-server JSON-RPC protocol. Inbound RPC methods the
server handles:

- `initialize`
- `thread/start` — create a fresh Claude thread with developer
  instructions + projected OpenClaw dynamic tools
- `thread/resume` — patch cwd/approvalPolicy/developerInstructions
  in-place; falls back to thread-not-found gracefully
- `thread/fork` — TODO; planned for catalog-change continuity
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

## How it relates to the OpenClaw bridge

The bridge lives in `extensions/claude/src/app-server/` in the OpenClaw
fork and is what spawns this server. Three-piece architecture:

| Component | Where | Package |
|---|---|---|
| Bridge (in-tree, ships with OpenClaw) | `openclaw/openclaw` fork | `@openclaw/claude` |
| Plugin manifest | `openclaw/openclaw-plugins/openclaw-claude/plugin/` | `@openclaw/claude` |
| **JSON-RPC server (this package)** | `openclaw/openclaw-plugins/openclaw-claude/server/` | `@zeroaltitude/claude-app-server` |

The bridge directory is named `app-server/` because it implements the
codex-app-server *protocol* (matching the codex extension's
directory layout) — the actual server is this separate binary.

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

## Development

```sh
npm install
npm run build
npm test            # 81 tests
node bin/openclaw-claude-app-server.mjs  # run the server directly
```

Tests live in `tests/`; protocol-schema fixtures in
`src/protocol-schemas/`. Run a single test file with
`npx vitest run tests/<file>.test.ts`.

## License

MIT — Edward Abrams 2026.
