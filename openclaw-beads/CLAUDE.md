# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm run build   # tsc -> dist/ (the plugin loader consumes dist/index.js)
npm test        # builds, then node --test test/*.test.mjs
```

Both gates must pass before committing. Tests import from `dist/`, so a stale
build silently tests old code — always run `npm test` (which rebuilds), not
`node --test` alone.

## Architecture Overview

- `src/beads-cli.ts` — the only place that shells out to `bd`. Reads prefer the
  `.beads/issues.jsonl` export (a fast local file); writes always go through
  `bd` and then re-export. Failures surface as `BdCommandError`.
- `src/index.ts` — plugin entry: the `/beads` gateway routes (UI + JSON API),
  the `before_prompt_build` hook that injects `<plans_and_tasks>`, and the
  `gateway:startup` session-mapping hook.
- `src/session-map.ts` — issue↔session binding cache built at gateway startup.
- `src/ttl-cache.ts` — TTL + inflight-dedup cache guarding the two hot paths.

### The JSONL export is derived, not the store

`.beads/issues.jsonl` is a snapshot of the live Dolt DB. bd does **not**
auto-export after shell-initiated mutations (`bd close` in a terminal), so any
read that needs status truth calls `ensureFreshExport()` first. A failed export
is not fatal — but it must be reported, never swallowed, or every later read
serves stale status with no signal.

## Conventions & Patterns

### Failures in the heartbeat block must be loud (openclaw-beads-7sz)

The `<plans_and_tasks>` block is how an agent learns it has work. If it is
missing or empty, a heartbeat concludes "nothing to do" and idles. So:

- **Never emit nothing.** If the block cannot be built, emit
  `formatDegradedPlansAndTasksBlock()` — a block that says so out loud. An
  absent block is indistinguishable from an empty queue.
- **A per-repo failure must not drop the block.** Repos are independent; one
  bad `bd` invocation degrades one `<repo>` element.
- **Stay inside the runtime's budget.** OpenClaw caps `before_prompt_build` at
  15s (`DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK` in
  `openclaw/src/plugins/hooks.ts`) and **discards** the contribution on
  overrun. `runLoop.readyBudgetMs` (default 10s) bounds the whole build; keep
  it comfortably under the runtime cap.
- **An empty queue must be explainable.** The block reports per-repo counts
  (`ready_total`, `shown`, `hidden_unassigned`, `hidden_other_owner`,
  `hidden_over_limit`) so "no work" can be distinguished from "20 ready issues,
  all filtered out by the owner policy."
- **Preserve `bd` diagnostics.** Never collapse a failure to its message alone:
  a SIGTERM'd child has empty stderr, so exit code / signal / timeout / duration
  are the only evidence there is.

### The host can refuse the hook, and `api.on()` will not tell you (openclaw-beads-7k3)

`before_prompt_build` is a **conversation hook** (openclaw
`src/plugins/hook-types.ts` → `CONVERSATION_HOOK_NAMES`). The plugin loader
(`src/plugins/registry-registrars-tools-hooks.ts`) refuses a conversation-hook
registration from a **non-bundled** plugin — which we always are, loaded from
`plugins.load.paths` — unless the operator has set:

```json
"beads": { "hooks": { "allowConversationAccess": true }, "config": { … } }
```

The refusal is one `warn` diagnostic at gateway startup:

```
typed hook "before_prompt_build" blocked because non-bundled plugins must set
plugins.entries.beads.hooks.allowConversationAccess=true (plugin=beads, …)
```

and nothing else. `api.on()` returns `void` whether or not the handler was
accepted, so from inside the plugin everything looks healthy — while
`<plans_and_tasks>` is absent from **every** turn and every openclaw-beads-7sz
"never emit nothing" guarantee is inert, because none of that code runs. This
is what actually caused the four absent-block recurrences of 2026-08-03, across
three agents; it had been live since 2026-07-30 08:50.

Consequences for this plugin:

- **Contribute via `heartbeat_prompt_contribution` too.** It is a
  prompt-injection hook but NOT a conversation hook, so the host accepts it from
  a non-bundled plugin regardless of `allowConversationAccess`. It fires only on
  heartbeat turns (`hookCtx.trigger === "heartbeat"`, both the embedded runner's
  `attempt.prompt-helpers.ts` and the harness path's
  `prompt-compaction-hook-helpers.ts`), which is exactly the surface that
  decides whether an agent works or idles. The block reaches heartbeats even
  when the gate is closed.
- **Dedup on `ctx.runId`, and only on `ctx.runId`.** With access granted, both
  hooks fire in one prompt build (heartbeat contributions are joined ahead of
  `before_prompt_build`). Suppress the second one when the runId already
  contributed; when there is no runId, emit the duplicate. A duplicated block
  costs tokens, a missing one costs the whole work queue.
- **State the gate's verdict at activation.** `resolveConversationAccess()` +
  `formatConversationAccessBlockedDiagnostic()` log an ERROR naming the exact
  config path and remedy when the gate is closed, an INFO when it is open, and a
  WARN when the plugin cannot see `plugins.entries` at all. Never infer silence
  means health.
- **Log one accounting line per contribution** (`agent=`, `run=`, `chars=`,
  `degraded=`). A `chars=0 SUPPRESSED` line proves the plugin ran and chose to
  emit nothing — which no amount of host-side log reading could establish
  before. The gateway journal (`journalctl --user -u openclaw-gateway`) is the
  only forensic surface for a missing block.

### Retries

Read-only commands retry transient failures (timeout kills, Dolt lock
contention) via `runBdRead`; mutations are single-shot so a partially-applied
write is never replayed. Retry chains respect `BdRunOptions.deadlineMs`.
