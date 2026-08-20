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
npm install
npm run build   # tsc
npm test        # vitest run
```

## Architecture Overview

Security/taint-tracking plugin for OpenClaw. `src/security/index.ts` registers
handlers on OpenClaw's hook surface (`before_prompt_build`, `before_tool_call`,
`after_tool_call`, etc.) that build a per-turn provenance graph and classify
tool calls by trust level using:

- `composite-tools.ts` — resolves a tool+action pair to a composite key
  (e.g. `browser.navigate`) and its default output taint.
- `uri-extractor.ts` — extracts source URIs from tool call params so a URI
  trust pattern can override the tool's default taint.
- `uri-trust.ts` — glob-pattern URI → trust level classification.
- `tab-url-store.ts` — links a browser tab's aliases (raw CDP `targetId`,
  plus the friendly `tabId`/`suggestedTargetId`/`label` handles agents are
  told to prefer) to its current URL, so `uri-extractor.ts` can resolve a
  tab reference to a URI regardless of which handle the agent used.

### Persisted state pattern (`*-store.ts`)

Several stores (`watermark-store.ts`, `identity-store.ts`,
`blocked-write-store.ts`, `tab-url-store.ts`) persist to
`<workspaceDir>/.provenance/*.json` so state survives gateway restarts, and
follow the same shape:

- A class wrapping an in-memory `data` object, `load()`-ing from disk in the
  constructor (falling back to a fresh empty state on missing/corrupt file).
- Debounced writes via `scheduleSave()` (1s timer) + an explicit `flush()`.
- A `getShared<X>Store(workspaceDir)` singleton registry keyed by
  workspaceDir (`Symbol.for(...)` on `globalThis`), so every agent sharing a
  workspace sees and safely flushes the same on-disk state instead of racing
  independent in-memory copies.

## Conventions & Patterns

- Tests live under `src/**/__tests__/*.test.ts` (vitest). Persisted stores
  are tested with `mkdtempSync`/`rmSync` per test (see
  `identity-store.test.ts`, `tab-url-store.test.ts`) rather than mocking fs.
- `src/security/__tests__/test-shim.ts` provides `makeApi()`/`seedIdentity()`
  for driving `registerSecurityHooks()` through its real hook pipeline in
  tests, including a legacy-hook-name translation shim (see the file's
  header comment) for tests written before the mainline hook migration.

### Identity in tests: never put it on the ctx

The test shim does **not** invent identity. A hook ctx may carry only what
mainline's `PluginHookAgentContext` carries — `senderId` (and only when
`trigger === "user"`) plus `messageProvider`. `senderIsOwner`,
`sourceProvider`, `groupId` and `spawnedBy` never appear on it, so putting
them there tests nothing.

Two routes, pick by what the test asserts:

- **Ownership** → configure `ownerNumbers` and put the matching `senderId` on
  the ctx. `before_prompt_build` computes `senderIsOwner` itself via
  `computeSenderIsOwner()`; that is production's only route to owner status,
  and to the owner-DM message exception that hangs off it.
- **`groupId` / `spawnedBy` / `sourceProvider`** → `seedIdentity(dir, key, …)`,
  or fire `inbound_claim` / `subagent_spawned`. These reach the IdentityStore
  from those handlers in production and from nowhere else.

`makeApi()` used to auto-seed the store from ctx identity fields to keep the
pre-migration corpus green. That hid the real path twice over: it pre-wrote a
record whose `senderId` matched the hook's, so `resolveIdentitySeedReason()`
returned `undefined` and the `computeSenderIsOwner()` / `ownerNumbers` chain
never ran (three shipped bugs — `09d6cb7`, `72700d8`, `4b8ce31` — had a green
suite throughout); and it let a test claim ownership outright by setting
`senderIsOwner: true`. Removed in `openclaw-provenance-iz3`;
`makeApi({ autoSeedIdentity: true })` now throws. `production-identity-seed.test.ts`
is the reference for the seed chain, `initial-trust-classification.test.ts` for
the `identity.sourceProvider` branch.

### Approvals are gated at the command layer, not in `ApprovalStore`

`ApprovalStore` honours every `approve()` unconditionally. The gate is
`requireAuth: true` on the `/approve-exec` registration, enforced by core in
`src/plugins/plugin-command-execution.ts` against `isAuthorizedSender` — which
is owner-based *by default* but also satisfied by a configured
`commandsAllowFrom` allowlist, so it is not equivalent to `senderIsOwner`.
Don't reintroduce claims of a `senderIsOwner` approval gate; none exists.
