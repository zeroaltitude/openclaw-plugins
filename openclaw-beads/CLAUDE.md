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

### Claiming is atomic, and `any` is a retired sentinel (openclaw-1lw7)

On 2026-08-26 three agents claimed `openclaw-vaon` within four seconds and two
spawned implementation subagents onto it. Each had followed the injected
run-loop prose correctly — the prose was the bug. It said "mark the issue
in_progress", i.e. `bd update <id> --assignee <me> --status in_progress`, which
is **last-write-wins**: measured against a scratch DB, three concurrent agents
all exit 0 and all believe they won.

- **`bd update <id> --claim` is already a compare-and-set.** Measured on bd
  1.0.3 under genuine concurrency (3 racers × 6 rounds): exactly one winner
  every time, exit 0; losers exit **1** with `issue already claimed by <agent>`.
  Re-claiming as the current owner is idempotent (exit 0). We did not need to
  build a CAS — only to start using it.
- **`bd` treats the literal string `any` as a real claimant.** An issue stamped
  `assignee: any` refuses `--claim` from *everyone* (`issue already claimed by
  any`, exit 1). So the `any` sentinel made the atomic path unusable on exactly
  the broadcast population that races. "Anyone may claim this" is therefore a
  genuinely **unassigned** issue.
- We still **read** `any` as a broadcast synonym (`isBroadcastAssignee`) so
  historical issues stay visible and bindable, but we never **write** it:
  `createIssue` omits `--assignee` for it and `updateIssue` normalizes it to
  `""`, which clears the field and restores claimability.
- **The rule has two copies** — `shouldIncludeReadyIssue` in `src/index.ts` and
  `isIssueForAgent` in `src/session-map.ts`. They must move together; a test in
  `test/session-map.test.mjs` pins them against each other.
- **`runLoop.includeUnassigned` defaults to `true`.** With `any` retired,
  unassigned is the normal claimable state, so a `false` default would hide the
  whole shared backlog and silence the queue — the openclaw-beads-7sz failure
  mode, reintroduced through the assignee policy instead of through an error.

The injected prose is a **contract**, not styling: it is the only instruction an
agent gets on a heartbeat wake. `test/runloop.test.mjs` asserts that it names
the atomic verb, mandates the exit-code check, requires the loser to abort, and
explicitly forbids the read-then-write substitute. Keep it in lockstep with
`~/.openclaw-narcissus/refs/openclaw.md` § "Beads run-loop discipline" — two
conflicting instructions are worse than the original bug.

### The claim mechanism itself (openclaw-1lw7 hardening)

The section above establishes the policy: `--claim` is the atomic verb and `any`
is retired. This one covers the machinery that makes it a *mechanism* rather
than an instruction, because the instruction is the part that had already failed
three times.

- **`src/claim.ts` owns the sentinel set and the outcome taxonomy.**
  `normalizeAssignee` collapses `any`/`anyone`/`unassigned`/`none`/`nobody`
  case- and whitespace-insensitively, so `"ANY "` cannot slip past a
  `=== "any"` check. `isBroadcastAssignee` in `index.ts` and `isIssueForAgent`
  in `session-map.ts` both delegate here — one definition, three call sites.
- **`already-claimed`, `sentinel-blocked` and `error` are three different
  verdicts and bd reports the first two identically.** `classifyClaimFailure`
  splits them. Getting this wrong is worse than the original bug in both
  directions: reading `already claimed by any` as a lost race makes every agent
  stand down from shared work forever, and reading a timeout as a win puts two
  agents on one issue. An unexplained failure is `error` = ownership **UNKNOWN**,
  never a win.
- **`claimIssue()` re-exports after a win.** bd does not auto-export, and the
  readiness fast path reads `.beads/issues.jsonl`. Without the refresh the very
  next prompt build still sees the issue as unassigned and offers it to somebody
  else — a won claim invisible to the queue is no better than no claim.
- **`POST /beads/api/issue/<id>/claim` answers 409 on a lost race**, not 500. A
  lost race is the mechanism working. 200 means, and only means, "you own this".
- **Retiring a sentinel is a migration, never part of claiming.**
  `normalizeSentinelAssignees()` runs per repo at `gateway:startup`. Its safety
  does not rest on being the only writer: it only touches rows whose assignee is
  *exactly* a sentinel, and a genuine claim's assignee is an agent id — so it
  cannot wipe a live claim. A test asserts exactly that. **Never** tell an agent
  to `--assignee ""` then `--claim`: two writes, and the second clear wipes the
  first agent's claim, leaving two winners. The block tells agents to stand down
  on `sentinel-blocked` instead, and `test/runloop.test.mjs` pins that (it is
  deliberately inverted from an earlier revision that required the racy advice).
- **The offer registry is a gate, not the mechanism.**
  `src/shared-offer-registry.ts` hands a shared issue id to exactly one agent at
  a time, so a collision cannot happen even if an agent ignores the claim
  instruction. It is an in-process map, genuinely atomic across competing prompt
  builds (one gateway, one thread — exactly the population that collided) but
  **not** durable or multi-host. Do not promote it to "the mechanism"; the
  compare-and-set in the database is. Withheld issues are counted as
  `hidden_offered_elsewhere` and explained in the block, per openclaw-beads-7sz.
  Offers lapse (`runLoop.sharedOfferTtlMs`, default 5 min) so an unused offer
  parks an issue for at most one heartbeat cycle rather than forever.

**The installed `bd` is not `~/projects/beads`.** That checkout gates claims on
`status = 'open'` in addition to assignee; the deployed v1.0.3 binary claims an
`in_progress` unassigned row happily (verified). Derive claim behavior from the
binary you actually run. This is also why the tempting upstream one-liner
(teach the claim predicate that `any` is not a claimant) was *not* the fix we
shipped — we cannot validate a patch against a tree that isn't what runs here.

### Retries

Read-only commands retry transient failures (timeout kills, Dolt lock
contention) via `runBdRead`; mutations are single-shot so a partially-applied
write is never replayed. Retry chains respect `BdRunOptions.deadlineMs`.
