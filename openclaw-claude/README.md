# openclaw-claude

Source for the **JSON-RPC bridge server** that lets
[OpenClaw](https://github.com/openclaw/openclaw) drive Anthropic Claude
turns through the same codex-shaped harness pattern it uses for OpenAI
Codex (`@openai/codex`).

## Layout

```
openclaw-claude/
  server/    — @zeroaltitude/openclaw-claude-bridge (published npm package)
```

`server/` builds and publishes the binary `openclaw-claude-bridge`. The
binary speaks JSON-RPC 2.0 over stdio (mirroring the codex-app-server
protocol) and wraps [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

The matching client lives **in-tree** in the
[`zeroaltitude/openclaw`](https://github.com/zeroaltitude/openclaw)
fork of the upstream OpenClaw repo, on branch
[`feat/claude-app-server-extension`](https://github.com/zeroaltitude/openclaw/tree/feat/claude-app-server-extension)
under `extensions/claude/src/app-server/`. That in-tree client is what
`openclaw` builds + ships; this repository only owns the external
server. The branch will be upstreamed to `openclaw/openclaw` once the
PR lands.

## Status

- `server/` — published as
  [`@zeroaltitude/openclaw-claude-bridge`](https://www.npmjs.com/package/@zeroaltitude/openclaw-claude-bridge);
  fork-preview path while the upstream PR for the OpenClaw bridge is in
  review. Expected to migrate to `@openclaw/openclaw-claude-bridge` when
  maintainers republish under the `@openclaw` scope.

## Architecture (two-piece)

```
OpenClaw gateway
  └─► extensions/claude/src/app-server/  (in-tree bridge — zeroaltitude/openclaw fork)
        └─► JSON-RPC 2.0 over stdio
              └─► openclaw-claude-bridge  (this repo's server/)
                    └─► @anthropic-ai/claude-agent-sdk
                          └─► Anthropic Messages API
```

A previous `openclaw-claude/plugin/` directory mirrored what the in-tree
bridge does and was never published. It was removed on 2026-05-23; see
git history for that scaffolding if a republished `@openclaw/claude`
plugin form is ever needed.

## Working on the server

```bash
cd server
npm install
npm run build
npm test            # 101 tests
node bin/openclaw-claude-bridge.mjs   # run the server directly
```

See `server/README.md` for the full feature set + protocol notes.
