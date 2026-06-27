# CLAUDE.md — openclaw-claude (Claude app-server bridge)

Guidance for an AI agent (or human) modifying this codebase. The `README.md`
files describe what the package *is* and how to install it; **this file
describes how to safely change it.** Read it before touching `server/src`.

## What this repo is

Two halves of one feature — the **Claude app-server bridge** — that lets
OpenClaw drive Anthropic Claude turns through the same harness shape it uses for
OpenAI Codex:

1. **`server/`** — `@zeroaltitude/openclaw-claude-bridge`, a standalone npm
   package. A JSON-RPC 2.0 server over stdio that wraps the
   `@anthropic-ai/claude-agent-sdk` and emits **codex-app-server-shaped**
   notifications (`turn/started`, `item/started`, `item/completed`,
   `turn/progress`, `thread/tokenUsage/updated`, …). This is the process the
   OpenClaw extension spawns. **This repo owns only the server.**
2. **The consumer** — the `extensions/claude` plugin — lives in the **OpenClaw
   repo**, NOT here. It is on the branch
   `feat/claude-app-server-extension` (PR
   https://github.com/openclaw/openclaw/pull/86655). It spawns the bridge
   binary and projects the bridge's notifications into OpenClaw's channel /
   session / hook model.

When you change behavior at the bridge boundary, you almost always touch BOTH
halves. They live in two repos. Keep them in lockstep (see "The two-repo dance").

## The mental model that matters most

The bridge's whole job is **protocol translation**: Anthropic SDK stream events
→ codex-app-server notifications. The OpenClaw consumer was written against
Codex; the bridge's contract is "look enough like Codex that the consumer can't
tell the difference." So the recurring design question is always:

> *What does Codex's app-server emit here, and how do I make Claude's SDK
> produce the equivalent?*

`extensions/codex/src/app-server/*` (in the OpenClaw repo) is the reference
implementation. When in doubt, read what Codex does and mirror it. Divergence
from Codex is a smell unless there's a Claude-specific reason (no model-backed
approvals reviewer, no `guardian_subagent`, different tool surface).

## Server source map (`server/src`)

| File | Responsibility |
|------|----------------|
| `server.ts` | JSON-RPC method dispatch; thread/turn lifecycle entry points. |
| `turn-runner.ts` | **The heart.** Drives one Claude turn: spins the SDK `query()` stream, translates each stream event into codex-shaped item notifications, manages keepalive + subagent-activity progress, token usage. Most behavior bugs live here. |
| `approval-bridge.ts` | Routes the SDK's native-tool approval requests through OpenClaw's BeforeToolCall chain (`registerApprovalHandler`). The `never→untrusted` promotion lives near here / in the consumer. |
| `thread-store.ts` / `session-store.ts` | Thread metadata + SDK session persistence (resume vs fresh). |
| `dynamic-tools.ts` | Bridges OpenClaw dynamic tools into the SDK as an MCP server; emits item/started+completed around each call. |
| `models.ts` | Model id resolution / capability gating (e.g. Fast mode per-model). |
| `rate-limits.ts` | Parses Anthropic 429s into a user-legible retry message. |
| `plugin-inventory.ts` / `plugin-thread-config.ts` | Per-thread tool policy + plugin metadata the consumer hands down. |
| `protocol.ts` / `validators.ts` | Wire types + runtime validation of inbound params. |
| `version.ts` / `version-compare.ts` | Hand-maintained version constant + semver compare for the consumer's min-version gate. |
| `transport.ts` | stdio framing for JSON-RPC. |
| `user-input.ts` / `image-payload-sanitizer.ts` | Inbound prompt + image normalization. |

## How a turn flows (read `turn-runner.ts` with this in hand)

1. `query({ prompt, options })` returns an async iterable of SDK messages.
2. For each message:
   - `stream_event` → `handleStreamEvent` maps `content_block_start/delta/stop`
     into `item/started` (agentMessage / reasoning / toolCall), streaming
     deltas, and `item/completed`.
   - `assistant` → coalesced message; used to retag the trailing block as
     `final_answer` when `stop_reason === "end_turn"`.
   - `result` → terminal; emit `thread/tokenUsage/updated` (read REAL usage
     from the session JSONL, not the summarized `result.usage`).
   - `default` → any other SDK message emits a non-heartbeat `turn/progress`
     so the consumer's idle watchdog sees activity.
3. **Two keepalive/progress timers run in parallel** (this is subtle, see below).

## The progress / idle-watchdog contract (DON'T break this)

The consumer (`run-attempt.ts`) runs two watchdogs:

- **turnIdleTimeoutMs** — resets on ANY turn notification, *including* the
  bridge's 30s `turn/progress {kind:"heartbeat"}`. So heartbeats keep this one
  alive.
- **progressIdleTimeoutMs** — advances ONLY on *real* activity. A
  `turn/progress` whose `kind === "heartbeat"` is **deliberately ignored** here,
  so a turn that is heartbeating-but-producing-nothing (a true hang) still dies.

Therefore, in the bridge:

- The 30s heartbeat (`kind:"heartbeat"`) is a pure keepalive. It must NEVER be
  the only thing flowing during *real* work, or the consumer can't tell a
  working turn from a hung one.
- Any progress that represents **genuine activity** must use a
  `kind !== "heartbeat"` (e.g. `subagentActivity`, or the `default`-case SDK
  message type). The consumer counts those as real progress.

**The native-subagent stall (openclaw-cm1 / #86655) — the canonical example.**
A native `Agent`/`Task` tool runs in an SDK child process that bubbles NO
messages to the parent iterator on the installed SDK version. The tool_use
block's `item/started`+`item/completed` bracket only the LLM *describing* the
call; the real run happens *after* the block closes, silently. So during a
subagent run only the heartbeat flows → consumer ignores it → turn killed at
`progressIdleTimeoutMs`. **Fix (in `turn-runner.ts`):** while a native subagent
is in flight, emit periodic `turn/progress {kind:"subagentActivity"}` (the
`createSubagentActivityEmitter` controller — armed on the `Agent`/`Task`
`content_block_stop`, disarmed the instant any further stream event arrives).
The consumer needs no change because it already counts non-heartbeat progress.
A consumer-side belt-and-suspenders (`subagentProgressIdleTimeoutMs`) widens the
budget for OLDER bridges that don't emit `subagentActivity`.

General rule when you add a long-silent operation: **ask whether the SDK emits
anything to the parent iterator during it. If not, you must emit your own
non-heartbeat progress, or the consumer will tear the turn down.**

## Approval / security model (don't relax it by accident)

- The bridge passes `approvalPolicy` to the SDK. `"never"` ≈ the SDK's
  `bypassPermissions` (no gating). But the bridge does NOT pass it straight
  through: when an OpenClaw `BeforeToolCall` policy is registered
  (`hasBeforeToolCallPolicy()`), the bridge promotes `never → untrusted`, which
  flips the SDK to `bypassPermissions: false` so its native Bash/Edit/Write
  emit approval requests — and `registerApprovalHandler` routes those through
  OpenClaw's same approval round-trip (✅/🔒/❌). So with a gating plugin
  loaded (e.g. `openclaw-provenance`), native tools are gated; with none
  loaded, `never` stays `never`. Preserve this — it's the answer to the
  "approvalPolicy: never is unsafe" review concern.
- The consumer (not the bridge) owns deriving default `approvalPolicy`/`sandbox`
  from core exec-policy + the enterprise requirements floor (guardian parity).

## Validation gate (server) — run before any commit

```sh
cd server
npm run build         # tsc — must be clean
npm test              # vitest — all green
npm pack --dry-run    # confirms the publishable tarball
```

- **Version is in TWO places and a test enforces they match:**
  `server/src/version.ts` (`OPENCLAW_CLAUDE_BRIDGE_VERSION`) AND
  `server/package.json` (`version`). Bump BOTH. `tests/version-sync.test.ts`
  fails otherwise (this bit us at 0.2.5).
- New behavior at the notification boundary → add/extend a vitest test. The
  subagent-activity emitter is unit-tested in `tests/subagent-activity.test.ts`
  via the extracted `createSubagentActivityEmitter` factory + fake timers — a
  good template: extract the timer/emit logic into an exported factory so it's
  testable without a live SDK stream.

## The two-repo dance (bridge ⇄ consumer)

A bridge change that the consumer must SEE requires a coordinated rollout:

1. **Bridge:** make the change in `server/`, bump version (both files), build,
   test, pack. **Do NOT `npm publish`** — publishing needs npm 2FA; Eddie does
   it (tmux flow). The agent stops at "packed, ready to publish."
2. **Publish (Eddie):** `npm publish` the new bridge version.
3. **Consumer pin:** only AFTER the version is live on npm, bump
   `extensions/claude/package.json`'s `@zeroaltitude/openclaw-claude-bridge`
   pin to the new version and refresh the lockfile (`pnpm install`). Bumping the
   pin *before* publish makes `pnpm install` fail with
   `ERR_PNPM_NO_MATCHING_VERSION` and breaks the branch for everyone — so this
   is a deliberate post-publish follow-up commit, not part of the feature
   commit.
4. **Min-version gate:** `extensions/claude/src/app-server/version.ts`
   (`MIN_CLAUDE_BRIDGE_VERSION`) is a HARD floor — raising it breaks operators
   on older bridges. Only raise it for a change the consumer genuinely cannot
   tolerate the absence of. Additive, gracefully-degrading bridge features
   (like `subagentActivity`) must NOT raise it.

## Conventions

- **We own this repo** → standard recursive `CLAUDE.md` rules. Keep this file
  current; add folder-local `CLAUDE.md` where local context warrants.
- **Signed commits:** run `~/.openclaw-tank/bin/unlock-gpg.sh` once per session
  before the first commit so it lands Verified.
- **Codex parity is the design oracle.** Before inventing bridge behavior, read
  the matching `extensions/codex/src/app-server` code in the OpenClaw repo.
- **Comments earn their keep.** The hard-won knowledge here (why the heartbeat
  exists, why `never→untrusted`, why the subagent emitter arms on block-stop)
  is in long inline comments on purpose. Preserve and extend them; a future
  agent with no transcript continuity relies on them.
