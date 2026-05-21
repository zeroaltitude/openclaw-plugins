# Roadmap: OpenClaw tools callable from inside a Claude turn

The server already implements every codex-protocol seam needed for OpenClaw
tools to flow into a Claude turn (phase 5 in the build log): the plugin
sends `dynamicTools` at `thread/start`, the server registers them on its
in-process MCP server with raw JSON Schema, the SDK exposes them to Claude,
and when Claude calls one the server emits an `item/tool/call` JSON-RPC
request back to the plugin and feeds the response into the model.

What's missing today is **the plugin layer between OpenClaw's tool registry
and our server's `dynamicTools` parameter**. The current plugin sends
`dynamicTools: undefined` because it has no way to enumerate OpenClaw's
tools — the third-party `PluginApi` we duck-type doesn't expose that.

This doc lays out the two paths forward.

## The constraint, restated

`openclaw-claude/plugin/src/types.ts` defines a minimal `PluginApi`:

```ts
export type PluginApi = {
  registerAgentHarness: (harness: AgentHarness) => void;
  pluginConfig: Record<string, unknown> | undefined;
  config: Record<string, unknown>;
  logger: { … };
};
```

That's the entire third-party contract. There's no field that exposes
OpenClaw's tool registry. The codex extension in `openclaw/extensions/codex/`
reaches deeper seams (`openclaw/plugin-sdk/agent-harness-runtime`,
`openclaw/plugin-sdk/plugin-runtime`) precisely because it's bundled
in-tree.

## Path SDK-1 — Promote the plugin into the openclaw monorepo

Move `openclaw-plugins/openclaw-claude/plugin/` into
`openclaw/extensions/claude/` on a branch. The server stays where it is
(an external npm package the in-tree plugin spawns).

### What changes

1. Create `openclaw/extensions/claude/` with the same source layout as the
   existing third-party plugin: `src/index.ts`, `src/harness.ts`,
   `src/rpc.ts`, `src/types.ts`. The four files are mostly portable —
   replace duck-types with real `openclaw/plugin-sdk/*` imports.
2. Add `openclaw/extensions/claude/openclaw.plugin.json` and a sibling
   `CLAUDE.md` symlink per the extensions boundary rules in
   `openclaw/extensions/CLAUDE.md`.
3. Add the new extension id to `.github/labeler.yml` per the openclaw
   AGENTS.md rule.
4. Inside `runAttempt`, before calling `thread/start`, gather OpenClaw's
   tools via the plugin-SDK seam — codex's pattern is to call
   `listRegisteredPluginAgentPromptGuidance` and the SDK's dynamic-tools
   helpers (see `openclaw/extensions/codex/src/app-server/thread-lifecycle.ts`
   for the reference). Project each tool into the `DynamicToolSpec` shape:
   ```ts
   { name, description, inputSchema }
   ```
5. Send the resulting array as `thread/start.dynamicTools`. Done — the
   server already does the rest.

### Effort

Mostly mechanical. The plugin's protocol layer doesn't change at all
(our server's API stays codex-shaped). The only new code is the
"enumerate + project" step. Estimate: half a day, plus the AGENTS.md
boundary-rules paperwork (labeler.yml entry, CLAUDE.md symlink, dep
declaration).

### Trade-off

You give up the third-party-plugin posture (the plugin lives in the
openclaw repo's CI/release cadence) in exchange for full SDK access.
Given Claude is a first-class provider for OpenClaw, in-tree is the
natural home — codex is in-tree, and the architectural symmetry is
worth the move.

## Path SDK-2 — Expand the public Plugin SDK

Stay third-party. Extend `PluginApi` (or add a new SDK entrypoint) with
two methods:

```ts
type PluginApi = {
  // existing fields …
  tools: {
    list(opts?: { surface?: string }): ToolDescriptor[];
    execute(
      name: string,
      args: unknown,
      ctx: { sessionId: string; abortSignal?: AbortSignal },
    ): Promise<ToolExecutionResult>;
  };
};
```

The plugin calls `api.tools.list()` to project descriptors, calls
`api.tools.execute()` from inside the `item/tool/call` server-request
handler, and forwards the result to the server.

### What changes

1. In the openclaw monorepo, design and publish a stable
   `openclaw/plugin-sdk/tool-registry-api` entrypoint that exposes
   read+execute over OpenClaw's internal tool registry. The exposed shape
   needs to be serialization-safe and forward-compatible.
2. Update `PluginApi` to carry the new field and document in
   `openclaw/docs/plugins/sdk-overview.md`.
3. Update the openclaw-claude plugin to consume the new API and emit
   `dynamicTools` from it.

### Effort

Larger. The Plugin SDK is a public surface; adding to it requires the
careful API design that the openclaw extensions/CLAUDE.md notes
("public/hostile/observed malformed input gets care"). Probably 2-3 days
including doc + contract tests.

### Trade-off

Cleaner abstraction long-term — codex would arguably benefit from
migrating to the same public seam. But shipping it takes longer and
requires committing to API stability.

## Recommendation

**SDK-1 (in-tree promotion) for v1.** The architectural symmetry with
codex is the simplest, most-faithful path. SDK-2 is a worthwhile follow-up
once the in-tree plugin has shaken out the actual shape of the
"openclaw tools projected as dynamic tools" surface — at which point you
have something concrete to harden into the public SDK.

## What `dynamicTools` enables once it's wired

Concrete examples from OpenClaw's existing tool registry:

- **Messaging**: Claude can call the `message` tool to send messages
  through the OpenClaw channel infrastructure — Slack, Discord, iMessage,
  etc. Today the codex extension does this; with phase-5 wiring +
  in-tree promotion, Claude can too.
- **Memory**: Claude can query OpenClaw's memory system (LanceDB, wiki
  vault) via the existing memory tools.
- **Browser / web**: Claude can drive OpenClaw's browser plugin.
- **Sessions**: Claude can spawn sub-sessions, hand off, schedule cron.

None of this requires server-side changes. It all unlocks the moment
the plugin can send a populated `dynamicTools` array at `thread/start`.

## Test fixture

The phase-5 smoke at `/tmp/openclaw-claude-server-smoke-phase5.mjs`
exercises the full round-trip with a synthetic `secret_phrase` tool.
That smoke is a working template — replace its in-line handler with a
real `openclaw/plugin-sdk/tool-registry-api` call once SDK-1 lands and
you have a regression test for the openclaw-tools-through-Claude path.
