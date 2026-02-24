# Session Handoff — Provenance Plugin Work (2026-02-23)

## What Happened Today

Eddie noticed I could run `exec` after `web_fetch` without `.approve` — a serious taint bypass bug.

### Bug: Watermark Cleared Every Turn

**Root cause:** `before_agent_start` hook used `event.messages.length <= 1` to detect fresh sessions and clear watermarks. But `event.messages` only contains the triggering message (not full history), so the watermark was wiped on EVERY turn. Cross-turn taint persistence was completely broken.

**Fix:** Moved watermark clearing to `context_assembled`, which has the real `messageCount`. Commit `c1cd99a` on main.

**Irony:** The LLM "played along" with being blocked by reading prior error messages in context, making it look like taint worked. On retry ("try again"), it just called exec successfully because nothing was actually blocked.

### Also Shipped

1. **Hook profiling** (`406c48c`) — All 7 hooks now log execution time when > 1ms via `profiled()` wrapper. Verbose mode controlled by existing `verbose` config flag.

2. **Latency tracking** (`2f4ff9d`) — Logs `ctx_assembled→first_llm` time per turn. Had to fix: `before_agent_start` doesn't fire on current OpenClaw, and iterations are 1-indexed not 0-indexed.

### Key Finding: Hooks Are Not the Latency Issue

All hooks run in 1-8ms each. Total provenance overhead per iteration: ~20ms. The perceived slowness Eddie noticed is from **context size growth** — we're at 262 messages / 101k tokens. Time-to-first-token scales with input size.

## Current State

- Branch: `main` at commit `2f4ff9d`
- All 90 tests passing
- Plugin is deployed and running with the watermark fix + profiling
- `before_agent_start` hook doesn't fire on current OpenClaw version — something to investigate upstream

## Open Items

1. **Test the watermark fix** — do a `web_fetch`, then on the NEXT turn try `exec`. It should be blocked now.
2. **Context size / latency** — 262 messages in context is causing slow TTFT. Need to look at OpenClaw compaction settings or session windowing.
3. **Upstream:** File issue/PR for `before_agent_start` not firing, and request message-receipt + typing-indicator timestamps for full latency profiling.
