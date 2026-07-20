/**
 * Drives a single turn: builds the SDK `query()` call, iterates its
 * AsyncGenerator<SDKMessage>, maps each event onto a codex-shaped
 * notification, and assembles the final Turn record for `turn/completed`.
 *
 * Stream-event handling reconstructs items at Anthropic-content-block
 * granularity:
 *   content_block_start("text") → emit item/started (agentMessage)
 *   content_block_delta(text_delta) → emit agentMessage/delta
 *   content_block_stop → emit item/completed
 *   (same pattern for thinking blocks; thinking_delta is a separate variant)
 *
 * For phase 4 we only consume text + thinking content blocks. Tool_use /
 * tool_result blocks are stubbed (we don't yet inject any tools); they'll
 * become first-class in phase 5 (dynamicTools + MCP bridge).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { ActiveTurn } from "./active-turns.js";
import { buildCanUseTool } from "./approval-bridge.js";
import {
  computeAttemptFingerprint,
  type AttemptEntry,
  type AttemptRegistry,
} from "./attempt-registry.js";
import {
  buildDynamicToolsMcpServer,
  type DynamicToolCallResponse,
  type ToolCallBridge,
} from "./dynamic-tools.js";
import { formatRateLimitMessage, parseAnthropicRateLimitError } from "./rate-limits.js";
import {
  thinkingBudgetForEffort,
  requiresAlwaysOnThinking,
} from "./models.js";
import type {
  DynamicToolCallOutputContentItem,
  JsonValue,
  ReasoningEffort,
  ThreadItem,
  Turn,
  TurnCollaborationMode,
  UserInput,
} from "./protocol.js";
import type { OpenClawSessionStore } from "./session-store.js";
import type { ThreadMeta, ThreadStore } from "./thread-store.js";
import type { Logger } from "./transport.js";
import {
  buildContentBlocks,
  ControllableUserInputQueue,
  makeSDKUserMessage,
} from "./user-input.js";

const DYNAMIC_TOOL_CALL_TIMEOUT_MS = 600_000;

export type RunTurnInput = {
  meta: ThreadMeta;
  turn: ActiveTurn;
  input: UserInput[];
  effort: ReasoningEffort | null;
  /**
   * Per-turn Fast mode opt-in. When true, the SDK is invoked with
   * `settings: { fastMode: true }` so the model runs in the Claude Code Fast
   * tier when the model supports it. Anthropic gates Fast mode per-model;
   * the SDK reports a per-result `fast_mode_state: "off" | "cooldown" | "on"`.
   * Bridges should only set this when their caller has already verified
   * model capability — the bridge does not re-check `supportsFastMode`.
   */
  fastMode?: boolean | null;
  /**
   * Set when the caller knows this thread is one-shot (heartbeat, cron, or a
   * subagent dispatch — never reused for a follow-up turn), as opposed to an
   * interactive chat that may send another turn on the same thread at any
   * time. When true, the attempt is discarded (its subprocess closed)
   * immediately once this turn completes, instead of sitting idle until the
   * query-thread-timeout sweep reaps it for no benefit.
   */
  oneShot?: boolean;
  collaborationMode?: TurnCollaborationMode | null;
  modelOverride?: string;
  sessionStore: OpenClawSessionStore;
  threadStore: ThreadStore;
  /**
   * Registry of live per-thread `Query` subprocesses. When the attempt
   * fingerprint (model/thinking/tool-policy/etc.) for this turn matches the
   * thread's currently-live attempt, the turn is fed into that already-running
   * subprocess instead of spawning a new one — see attempt-registry.ts.
   */
  attemptRegistry: AttemptRegistry;
  /** Emit a JSON-RPC notification to the client. */
  notify: (method: string, params: unknown) => void;
  /**
   * Issue a server→client JSON-RPC REQUEST and await its response. Used for
   * `item/tool/call` (dynamic tools) and the phase-7 approval requests.
   */
  requestClient: (
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<unknown>;
  logger: Logger;
};

export type RunTurnResult = {
  finalTurn: Turn;
};

export async function runTurn(args: RunTurnInput): Promise<RunTurnResult> {
  const { meta, turn, input, effort, sessionStore, notify, logger, attemptRegistry } = args;
  const model = args.modelOverride ?? meta.model;
  const fastMode = args.fastMode === true;
  // Built regardless of reuse-vs-create: every turn needs its message pushed
  // into whichever input queue ends up feeding the attempt.
  const initialContent = await buildContentBlocks(input);

  // Map codex effort → SDK thinking config.
  //
  // Anthropic's own 400 message spells out the contract: "Thinking defaults
  // to adaptive mode when not specified" — omitting the thinking param is
  // how a caller asks for model-default behavior, and is NOT the same as
  // explicitly disabling it. Previously this bridge conflated the two: any
  // unresolved effort (including OpenClaw's "adaptive"/"max" thinkLevels,
  // which this bridge's ReasoningEffort enum has no equivalent for and so
  // arrive as null/undefined) fell through to an explicit
  // thinking.type="disabled", which most models silently tolerate but which
  // Anthropic hard-rejects specifically for claude-fable-5.
  //
  // Only send `disabled` when the caller explicitly asked for none/minimal.
  // Otherwise, if a real budget resolves, send it; if nothing resolves at
  // all, omit `thinking` entirely and let Anthropic apply its own default —
  // which is exactly what "adaptive" should mean, and avoids ever sending a
  // disabled request a given model might reject.
  //
  // requiresAlwaysOnThinking is a narrower safety net on top of that: it
  // overrides even an *explicit* none/minimal request for models (like
  // fable-5) that reject disabled thinking outright, so a user picking "off"
  // for such a model degrades to a small real budget instead of a 400.
  const explicitlyDisabled = effort === "none" || effort === "minimal";
  const resolvedBudget = thinkingBudgetForEffort(effort ?? null);
  const thinking = requiresAlwaysOnThinking(model)
    ? ({ type: "enabled", budgetTokens: resolvedBudget ?? thinkingBudgetForEffort("low")! } as const)
    : explicitlyDisabled
    ? ({ type: "disabled" } as const)
    : resolvedBudget !== null
    ? ({ type: "enabled", budgetTokens: resolvedBudget } as const)
    : undefined;

  // includePartialMessages must be enabled to get `stream_event` partials
  // (token-level deltas). Without it the SDK emits only coalesced `assistant`
  // events at content-block boundaries, which is too coarse for codex's
  // item/agentMessage/delta notification protocol.
  // Claude Code's native subagent tools (Agent, Task) spawn sub-processes via
  // Claude Code's own infrastructure, which doesn't integrate with OpenClaw's
  // session/messaging/persistence story. Disable them so the model doesn't
  // surface them, and alias the names to `mcp__openclaw__sessions_spawn` so
  // any straggling tool_use emissions (from training-data habits) route to
  // OpenClaw's canonical subagent path. Operators can override via the
  // env vars below if they have a reason to keep the native tools active.
  // Native (claude_code preset) tools to block by default. Empty list — the
  // SDK's `Agent` / `Task` / `TaskOutput` / `TaskStop` are kept available so
  // they can serve as the inline-sync subagent path analogous to codex's
  // native `spawn_agent` / `sendInput` / `resumeAgent` / `wait` / `closeAgent`
  // (see extensions/codex/src/app-server/protocol-generated/json/v2 +
  // codex's thread-lifecycle dev-instruction at line ~840). The plugin's
  // developer instructions tell the model which path to use: native `Agent`
  // for inline subagent reasoning, OpenClaw `sessions_spawn` for genuine
  // cross-runtime / cross-agent delegation. Operators can override via the
  // OPENCLAW_CLAUDE_BRIDGE_DISALLOWED_TOOLS env (comma-separated).
  const disallowedNativeSubagentTools = (
    process.env.OPENCLAW_CLAUDE_BRIDGE_DISALLOWED_TOOLS ?? ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Merge env defaults with any per-thread additions the plugin computed
  // from OpenClaw's tool policy. Deduplicated. The aliasing for subagents
  // (Agent/Task → sessions_spawn) only applies to the env-default set so a
  // plugin-blocked tool is hard-blocked rather than aliased.
  const threadDisallowedNative = Array.isArray((meta as Record<string, unknown>).disallowedTools)
    ? ((meta as Record<string, unknown>).disallowedTools as unknown[]).filter(
        (n): n is string => typeof n === "string" && n.trim().length > 0,
      )
    : [];
  const mergedDisallowedNative = Array.from(
    new Set([...disallowedNativeSubagentTools, ...threadDisallowedNative]),
  );
  const openclawSubagentToolName = "mcp__openclaw__sessions_spawn";
  const subagentAliases: Record<string, string> = {};
  if (process.env.OPENCLAW_CLAUDE_BRIDGE_DISABLE_SUBAGENT_ALIAS !== "1") {
    for (const name of disallowedNativeSubagentTools) {
      subagentAliases[name] = openclawSubagentToolName;
    }
  }

  // Approval flow. Two bypass paths:
  //   1. Operator override via OPENCLAW_CLAUDE_BRIDGE_ALLOW_ALL=1 — affects
  //      every turn on every thread regardless of codex-protocol settings.
  //   2. Thread-level codex approvalPolicy: "never" — set by the plugin at
  //      thread/start to indicate this thread runs without prompting.
  // Otherwise the bridge emits codex-shaped server→client approval requests
  // (item/commandExecution/requestApproval, item/fileChange/requestApproval)
  // and awaits the plugin's decision per tool call.
  const allowAll =
    process.env.OPENCLAW_CLAUDE_BRIDGE_ALLOW_ALL === "1" ||
    meta.approvalPolicy === "never";

  // Dynamic tools (codex's per-thread tool set) and caller-supplied MCP
  // servers both bake into the SDK options at attempt-creation time, so both
  // feed the attempt fingerprint below.
  const dynamicTools = meta.dynamicTools ?? [];
  const systemPromptAppend =
    typeof meta.developerInstructions === "string" && meta.developerInstructions.trim()
      ? meta.developerInstructions
      : undefined;
  const cwd = typeof meta.cwd === "string" && meta.cwd.length > 0 ? meta.cwd : undefined;

  // Fingerprint the attempt-defining settings (run/attempt/turn hierarchy:
  // model, thinking, tool policy, permission mode, and dynamic tools are
  // fixed for an attempt's whole duration, never mid-attempt — see the
  // design note in attempt-registry.ts). If a live attempt already exists
  // for this thread with a matching fingerprint, this turn is a continuation
  // and gets fed into that already-running subprocess instead of spawning a
  // new one.
  const fingerprint = computeAttemptFingerprint({
    model,
    thinking,
    cwd,
    disallowedTools: mergedDisallowedNative,
    toolAliases: subagentAliases,
    fastMode,
    allowAll,
    systemPromptAppend,
    mcpServersConfig: meta.mcpServersConfig,
    dynamicTools,
  });

  const existingAttempt = attemptRegistry.get(meta.id);
  const canReuse =
    !!existingAttempt && !existingAttempt.closed && existingAttempt.fingerprint === fingerprint;

  let entry: AttemptEntry;
  if (canReuse && existingAttempt) {
    entry = existingAttempt;
    entry.liveTurnRef.turn = turn;
    entry.lastUsedAtMs = Date.now();
    entry.inputQueue.push(makeSDKUserMessage(initialContent));
  } else {
    if (existingAttempt) {
      attemptRegistry.discard(meta.id, "attempt fingerprint changed");
    }
    entry = await createAttempt({
      args,
      meta,
      turn,
      model,
      thinking,
      fastMode,
      allowAll,
      dynamicTools,
      mergedDisallowedNative,
      subagentAliases,
      systemPromptAppend,
      cwd,
      sessionStore,
      fingerprint,
      initialContent,
      logger,
    });
    attemptRegistry.set(meta.id, entry);
  }
  turn.inputQueue = entry.inputQueue;

  notify("turn/started", { threadId: meta.id, turnId: turn.turnId });

  // Periodic heartbeat. The activity-message heartbeat in the `default`
  // branch below only fires if the SDK emits something — but the SDK
  // can go genuinely silent for long stretches: native Task subagents
  // run entirely in a child process without bubbling progress to the
  // parent's iterator on this SDK version, Anthropic API latency on
  // cold-cache 1M-context reads can take minutes before the first
  // content_block_start arrives, and slow tool executions block the
  // iterator with no per-tool progress signal. The consumer's idle
  // watchdog (extensions/claude/src/app-server/run-attempt.ts default
  // 90s) tears the turn down with "model did not produce a response"
  // when no JSON-RPC notifications flow. A 30s timer-based heartbeat
  // guarantees a turn/progress notification regardless of SDK
  // behavior; the projector treats unknown methods as no-ops after the
  // matchesTurn check resets the timer, so content interpretation is
  // unaffected. Cleared in the finally block below regardless of
  // success or error path.
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeatTimer = setInterval(() => {
    try {
      notify("turn/progress", {
        threadId: meta.id,
        turnId: turn.turnId,
        kind: "heartbeat",
      });
    } catch (heartbeatErr) {
      logger.debug("[turn-runner] heartbeat notify threw", {
        error: heartbeatErr instanceof Error ? heartbeatErr.message : String(heartbeatErr),
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Native-subagent activity emitter. When the model invokes a native
  // claude_code subagent tool (`Agent` / `Task`), the SDK executes the
  // subagent in a child process that — on the installed SDK version — bubbles
  // NO progress messages to this parent iterator. The block-level events
  // (content_block_start/stop for the tool_use) only bracket the model
  // *describing* the call; the subagent's actual run happens AFTER the block
  // closes, during which the iterator blocks with zero output. The only signal
  // flowing in that window is the 30s `heartbeat` above — which the consumer's
  // idle watchdog (extensions/claude/src/app-server/run-attempt.ts) DELIBERATELY
  // ignores so genuinely-hung turns still die. Result: a real subagent run >
  // progressIdleTimeoutMs gets torn down mid-flight.
  //
  // Codex doesn't hit this because its server emits real typed progress
  // (commandExecution / mcpToolCall) throughout native operations, which the
  // consumer counts as activity. We mirror that here: while a native subagent
  // is believed in-flight, emit a periodic NON-heartbeat `turn/progress`
  // (kind:"subagentActivity"). The consumer treats any non-"heartbeat"
  // turn/progress as genuine progress and resets its idle watchdog — so this
  // fixes the stall for every consumer of the bridge with ZERO consumer change
  // required. The projector treats unknown kinds as no-ops, so content
  // interpretation is unaffected.
  //
  // "In-flight" is tracked optimistically: armed when an `Agent`/`Task`
  // tool_use block starts, disarmed the moment any further stream event arrives
  // (which means real activity resumed and the heartbeat/default paths take
  // over again). The interval is shorter than the heartbeat so a subagent that
  // starts just after a heartbeat tick still produces a non-heartbeat signal
  // well inside the consumer's idle budget. True hangs are still caught: this
  // only fires while a subagent tool was actually invoked this turn, and the
  // hard turnTimeoutMs remains the backstop.
  const subagentActivity = createSubagentActivityEmitter({
    notify,
    threadId: meta.id,
    turnId: turn.turnId,
    onError: (activityErr) => {
      logger.debug("[turn-runner] subagentActivity notify threw", {
        error: activityErr instanceof Error ? activityErr.message : String(activityErr),
      });
    },
  });

  const blocks = new Map<number, StreamItemRef>();
  const agentMessageTracker: AgentMessageTracker = {};

  try {
    // Consumes the attempt's shared message stream until this turn's
    // `result` message arrives, then returns WITHOUT closing anything —
    // unlike the old per-turn `for await`, the underlying subprocess (and
    // the pump loop feeding it) stays alive for the next turn. See
    // waitForTurnResult / pumpAttempt below and the design note atop
    // attempt-registry.ts for why a per-message handler replaces the loop.
    await waitForTurnResult(entry, async (msg) => {
      const m = msg;
      // Any real SDK message means the silent post-tool_use window is over —
      // disarm the subagent-activity emitter. handleStreamEvent re-arms it when
      // a fresh native subagent tool_use block opens. Disarm BEFORE dispatch so
      // re-arming inside this same event survives.
      subagentActivity.disarm();
      switch (m.type) {
        case "stream_event":
          handleStreamEvent(m, blocks, turn, meta, notify, agentMessageTracker, subagentActivity);
          break;
        case "assistant": {
          // Coalesced full message; stream events already produced the
          // items. Use `stop_reason` (only known at this point — message_delta
          // fires after every content_block_stop in the message) to
          // retroactively tag the trailing agentMessage block as the turn's
          // final answer. Bridges can then deliver the in-channel
          // transcript (commentary preambles) alongside the final reply
          // as separate channel messages.
          const assistantMessage = m.message as Record<string, unknown> | undefined;
          const stopReason =
            typeof assistantMessage?.stop_reason === "string" ? assistantMessage.stop_reason : null;
          if (
            stopReason === "end_turn" &&
            agentMessageTracker.lastItemId &&
            typeof agentMessageTracker.lastText === "string"
          ) {
            const finalAnswerItem = makeAgentMessageItem(
              agentMessageTracker.lastItemId,
              agentMessageTracker.lastText,
              "final_answer",
            );
            // Update the in-memory turn.items so turn/completed carries
            // the resolved phase too.
            const idx = turn.items.findIndex((it) => it.id === finalAnswerItem.id);
            if (idx >= 0) turn.items[idx] = finalAnswerItem;
            notify("item/updated", {
              threadId: meta.id,
              turnId: turn.turnId,
              item: finalAnswerItem,
            });
          }
          // Always reset at the end of each assistant message so the
          // next assistant message in this turn starts with a fresh
          // tracker. Crucially, a tool-only continuation message (no
          // text blocks) would otherwise keep the prior message's
          // tracked item id and could mis-tag an earlier commentary
          // block as final_answer when the eventual end_turn arrives.
          agentMessageTracker.lastItemId = undefined;
          agentMessageTracker.lastText = undefined;
          break;
        }
        case "result": {
          // Terminal — emit token usage so consumers can track context growth.
          // The SDK's result.usage is a summarised view that may zero out
          // cache_read_input_tokens. Read the last assistant record from the
          // session JSONL instead — the SDK writes the real per-call Anthropic
          // API usage there (including cache_read_input_tokens).
          const resultUsage = m.usage as Record<string, unknown> | undefined;
          const messagesPath = args.threadStore.messagesPath(meta.id);
          const transcriptUsage = messagesPath
            ? await readLastAssistantUsage(messagesPath)
            : undefined;
          const effectiveUsage = transcriptUsage ?? resultUsage;
          if (effectiveUsage) {
            notify("thread/tokenUsage/updated", {
              threadId: meta.id,
              turnId: turn.turnId,
              tokenUsage: {
                last: {
                  input_tokens: effectiveUsage.input_tokens ?? 0,
                  output_tokens: effectiveUsage.output_tokens ?? 0,
                  cache_creation_input_tokens: effectiveUsage.cache_creation_input_tokens ?? 0,
                  cache_read_input_tokens: effectiveUsage.cache_read_input_tokens ?? 0,
                },
              },
            });
          }
          break;
        }
        case "system": {
          // Permission denials and other system events will be wired in phase 7.
          // Until then, leave a debug breadcrumb for visibility.
          logger.debug("[turn-runner] system event", { subtype: m.subtype });
          break;
        }
        default: {
          // Activity / unhandled SDK message. The SDK ships many message
          // types beyond the content-bearing `stream_event` / `assistant` /
          // `result` set (e.g. SDKTaskStartedMessage, SDKTaskProgressMessage,
          // SDKTaskUpdatedMessage, SDKToolProgressMessage, SDKStatusMessage,
          // SDKAPIRetryMessage, SDKHookStartedMessage, ...) during
          // long-running operations like native Task subagent runs or
          // tool execution. The bridge consumer's idle watchdog resets
          // on any JSON-RPC notification carrying this turnId — without a
          // heartbeat here, a Task subagent that runs for >90s (the default
          // turnIdleTimeoutMs) silently kills the parent turn with
          // "model did not produce a response before the model idle
          // timeout." Emit a minimal turn/progress notification so the
          // watchdog stays alive; the projector treats unknown methods as
          // no-ops after resetting the timer, so content interpretation is
          // unaffected.
          const kind = typeof m.type === "string" ? m.type : "unknown";
          notify("turn/progress", {
            threadId: meta.id,
            turnId: turn.turnId,
            kind,
          });
          logger.debug("[turn-runner] activity SDK event", { type: kind });
          break;
        }
      }
    });

    const completedAtMs = Date.now();
    const aborted = turn.abortController.signal.aborted;
    const status = aborted ? "interrupted" : "completed";
    turn.status = status;
    if (aborted) {
      // turn/interrupt already discards the attempt itself; this is defense
      // in depth against any other path that aborts a turn without going
      // through that handler. Idempotent — discard() no-ops if already gone.
      attemptRegistry.discard(meta.id, "turn aborted");
    } else if (args.oneShot) {
      // One-shot threads (heartbeat/cron/subagent) never return to reuse
      // their attempt — holding the subprocess alive until the idle sweep
      // would only cost memory for no benefit. Close it now.
      attemptRegistry.discard(meta.id, "one-shot turn completed");
    }
    const finalTurn: Turn = {
      id: turn.turnId,
      threadId: meta.id,
      status,
      startedAt: turn.startedAtSeconds,
      completedAt: Math.floor(completedAtMs / 1000),
      durationMs: completedAtMs - turn.startedAtMs,
      items: turn.items,
    };
    return { finalTurn };
  } catch (err) {
    const completedAtMs = Date.now();
    const baseMessage = err instanceof Error ? err.message : String(err);
    const aborted = turn.abortController.signal.aborted || /abort/i.test(baseMessage);
    const status = aborted ? "interrupted" : "failed";
    turn.status = status;
    // Whatever went wrong — subprocess crash, interrupt, or a bug in our own
    // message handling above — don't let a later turn silently inherit a
    // suspect attempt. Idempotent: the pump's own cleanup or turn/interrupt
    // may have already discarded it.
    attemptRegistry.discard(meta.id, aborted ? "turn aborted" : "turn failed");
    // Enrich Anthropic 429 / rate-limit errors with parsed bucket and
    // retry-after context so the user-visible final error explains WHY
    // and WHEN to retry instead of just surfacing the raw SDK message.
    const rateLimit = aborted ? null : parseAnthropicRateLimitError(err);
    const enriched = rateLimit ? formatRateLimitMessage(rateLimit) : baseMessage;
    const finalTurn: Turn = {
      id: turn.turnId,
      threadId: meta.id,
      status,
      startedAt: turn.startedAtSeconds,
      completedAt: Math.floor(completedAtMs / 1000),
      durationMs: completedAtMs - turn.startedAtMs,
      items: turn.items,
      error: aborted ? null : { message: enriched },
    };
    if (!aborted) {
      logger.warn("[turn-runner] turn failed", {
        turnId: turn.turnId,
        error: baseMessage,
        rateLimit: rateLimit ?? undefined,
      });
    }
    return { finalTurn };
  } finally {
    clearInterval(heartbeatTimer);
    subagentActivity.disarm();
  }
}

/**
 * Creates a brand-new attempt: builds the SDK options (model, thinking, tool
 * policy, approval bridge, dynamic tools, MCP servers — everything fixed for
 * the attempt's lifetime), spawns the `Query`/subprocess, and starts the
 * background pump that will keep demuxing its message stream to whichever
 * turn is currently live until the attempt is discarded.
 *
 * `canUseTool` and the dynamic-tools MCP bridge are built exactly once here
 * and never rebuilt on later reused turns (the SDK only reads them at
 * `query()` construction) — they read the current turn through
 * `liveTurnRef`, which `runTurn` repoints before feeding each subsequent
 * turn's input.
 */
async function createAttempt(params: {
  args: RunTurnInput;
  meta: ThreadMeta;
  turn: ActiveTurn;
  model: string;
  thinking: { type: string; budgetTokens?: number; display?: unknown } | undefined;
  fastMode: boolean;
  allowAll: boolean;
  dynamicTools: NonNullable<ThreadMeta["dynamicTools"]>;
  mergedDisallowedNative: string[];
  subagentAliases: Record<string, string>;
  systemPromptAppend: string | undefined;
  cwd: string | undefined;
  sessionStore: OpenClawSessionStore;
  fingerprint: string;
  initialContent: Awaited<ReturnType<typeof buildContentBlocks>>;
  logger: Logger;
}): Promise<AttemptEntry> {
  const {
    args,
    meta,
    turn,
    model,
    thinking,
    fastMode,
    allowAll,
    dynamicTools,
    mergedDisallowedNative,
    subagentAliases,
    systemPromptAppend,
    cwd,
    sessionStore,
    fingerprint,
    initialContent,
    logger,
  } = params;

  const liveTurnRef: { turn: ActiveTurn } = { turn };

  // `resume` is only safe when there's actual history to load — passing it
  // for a brand-new thread makes the SDK silently no-op the turn. We probe
  // the on-disk transcript and set `resume` only when it has content. Only
  // read here, at creation: a reused attempt never re-issues this option
  // since the SDK reads it once, at process-spawn time.
  const hasHistory = await transcriptHasEntries(args.threadStore.messagesPath(meta.id));

  // Attempt-scoped controller — separate from any single turn's
  // abortController. Aborting this kills the subprocess; a turn's own
  // abortController continues to scope just that turn's approval/dynamic-tool
  // request round-trips (see liveTurnRef usages below).
  const abortController = new AbortController();

  const sdkOptions: Record<string, unknown> = {
    model,
    sessionStore: sessionStore as unknown,
    abortController,
    // Omitted entirely (not sent as thinking: undefined) when unresolved —
    // see the comment above `thinking`'s computation in runTurn for why that
    // matters.
    ...(thinking ? { thinking } : {}),
    includePartialMessages: true,
    // Pin the SDK's working directory to the thread's cwd so the claude_code
    // preset's native Read/Edit/Bash tools operate inside the OpenClaw
    // effective workspace, not the server process cwd. Without this, native
    // tool calls effectively escape sandboxing for filesystem access.
    ...(cwd ? { cwd } : {}),
    ...(mergedDisallowedNative.length > 0 ? { disallowedTools: mergedDisallowedNative } : {}),
    ...(Object.keys(subagentAliases).length > 0 ? { toolAliases: subagentAliases } : {}),
    // Fast mode: when the caller has flagged this turn as Fast-eligible
    // (caller is responsible for checking model capability and harness
    // identity), thread it into the SDK's flag-settings layer. Settings.fastMode
    // is the highest-priority user-controlled toggle, so it overrides any
    // per-user persisted preference. We don't set fastModePerSessionOptIn —
    // the bridge is stateless per-attempt from the SDK's POV, and we want the
    // caller's intent to be authoritative.
    ...(fastMode ? { settings: { fastMode: true } } : {}),
  };
  if (hasHistory) {
    // On resume, sessionId is implied by `resume` — passing both can make
    // the SDK treat the call as a fork-with-id and reject the load.
    sdkOptions.resume = meta.id;
  } else {
    sdkOptions.sessionId = meta.id;
  }
  // System prompt strategy (Option 2 in the design discussion):
  //  - Use Claude Code's `claude_code` preset so the model inherits its
  //    built-in tool-use guidance for Read/Bash/Edit/Grep/Glob/etc.
  //  - Append OpenClaw's per-thread context (SOUL.md, workspace files,
  //    openclaw guidance) so it joins the cacheable static prefix.
  //  - excludeDynamicSections=true moves the preset's per-user dynamic
  //    sections (working dir, git status, auto-memory) out of the cached
  //    prefix and into the first user message, so the cache key stays
  //    stable across sessions of the same agent and cross-agent for the
  //    preset portion.
  // The result: a long-lived agent thread cold-writes once and hits cache
  // for every subsequent turn on a large, well-structured prefix.
  sdkOptions.systemPrompt = systemPromptAppend
    ? { type: "preset", preset: "claude_code", append: systemPromptAppend, excludeDynamicSections: true }
    : { type: "preset", preset: "claude_code", excludeDynamicSections: true };

  // Read fresh on every SDK callback for the attempt's whole lifetime, so
  // `canUseTool` and the dynamic-tools bridge (both built once, below) always
  // report the turn currently feeding this attempt without needing to be
  // rebuilt per turn.
  const ctx = {
    get threadId(): string {
      return liveTurnRef.turn.threadId;
    },
    get turnId(): string {
      return liveTurnRef.turn.turnId;
    },
  };

  if (allowAll) {
    sdkOptions.permissionMode = "bypassPermissions";
  } else {
    sdkOptions.permissionMode = "default";
    sdkOptions.canUseTool = buildCanUseTool({
      ctx,
      requestClient: args.requestClient,
      allowAll: false,
      logger,
    });
  }

  // Caller-supplied MCP servers (codex's `config.mcp_servers` patch). We
  // forward them verbatim to the SDK; the SDK manages connection lifecycle.
  const mcpServers: Record<string, unknown> = {};
  if (meta.mcpServersConfig) {
    for (const [name, cfg] of Object.entries(meta.mcpServersConfig)) {
      mcpServers[name] = cfg;
    }
  }

  // Build the dynamic-tools MCP bridge if the thread carries any. The bridge
  // forwards each tools/call up through JSON-RPC to the openclaw plugin and
  // emits codex-shaped item/started + item/completed notifications around it.
  if (dynamicTools.length > 0) {
    const bridge: ToolCallBridge = async ({ ctx: callCtx, callId, tool, args: toolArgs }) => {
      const response = await args.requestClient(
        "item/tool/call",
        {
          threadId: callCtx.threadId,
          turnId: callCtx.turnId,
          callId,
          tool,
          arguments: (toolArgs ?? null) as JsonValue,
        },
        {
          signal: liveTurnRef.turn.abortController.signal,
          timeoutMs: DYNAMIC_TOOL_CALL_TIMEOUT_MS,
        },
      );
      return coerceToolResponse(response);
    };

    const itemByCallId = new Map<string, ThreadItem>();
    const handle = buildDynamicToolsMcpServer({
      serverName: "openclaw",
      tools: dynamicTools,
      bridge,
      onCallStart: ({ tool, callId, args: toolArgs, ctx: callCtx }) => {
        const item = makeDynamicToolCallItem({
          callId,
          tool,
          args: toolArgs,
          status: "running",
          contentItems: null,
          success: null,
          durationMs: null,
        });
        itemByCallId.set(callId, item);
        liveTurnRef.turn.items.push(item);
        args.notify("item/started", {
          threadId: callCtx.threadId,
          turnId: callCtx.turnId,
          item,
        });
      },
      onCallEnd: ({ tool, callId, ctx: callCtx, response, durationMs }) => {
        const finalized = makeDynamicToolCallItem({
          callId,
          tool,
          args: itemByCallId.get(callId)?.arguments ?? null,
          status: response.success ? "completed" : "failed",
          contentItems: response.contentItems,
          success: response.success,
          durationMs,
        });
        // Replace the in-progress item in the CURRENT turn's items list —
        // liveTurnRef.turn, not the turn that was live when this closure was
        // built, since a reused attempt swaps in a new ActiveTurn per turn.
        const items = liveTurnRef.turn.items;
        const idx = items.findIndex((i) => i.id === finalized.id);
        if (idx >= 0) items[idx] = finalized;
        else items.push(finalized);
        itemByCallId.set(callId, finalized);
        args.notify("item/completed", {
          threadId: callCtx.threadId,
          turnId: callCtx.turnId,
          item: finalized,
        });
      },
      logger,
    });
    handle.ctxRef.current = ctx;
    mcpServers.openclaw = {
      type: "sdk",
      name: "openclaw",
      instance: handle.instance,
    };
  }
  if (Object.keys(mcpServers).length > 0) {
    sdkOptions.mcpServers = mcpServers;
  }

  const inputQueue = new ControllableUserInputQueue();
  inputQueue.push(makeSDKUserMessage(initialContent));
  // Deliberately NOT closed. `Query.streamInput()` only closes the
  // subprocess's stdin once this iterable is exhausted — keeping it open is
  // what keeps the subprocess alive across turns. It's closed only when the
  // attempt is discarded (fingerprint change, interrupt, idle sweep, crash,
  // or process shutdown) — see attempt-registry.ts.

  // Cast — SDK options surface is rich and the runtime accepts our subset.
  const stream = query({ prompt: inputQueue.iterate() as never, options: sdkOptions as never });

  const nowMs = Date.now();
  const entry: AttemptEntry = {
    threadId: meta.id,
    fingerprint,
    inputQueue,
    abortController,
    liveTurnRef,
    currentHandler: null,
    currentReject: null,
    closed: false,
    createdAtMs: nowMs,
    lastUsedAtMs: nowMs,
  };
  pumpAttempt(entry, stream as AsyncIterable<unknown>, args.attemptRegistry, logger);
  return entry;
}

/**
 * Awaits the current turn's `result` message from an attempt's shared
 * message stream. Registers `onMessage` as the attempt's `currentHandler`
 * (see pumpAttempt) so every message the pump reads until then is forwarded
 * here in order; resolves once `onMessage` has finished processing a
 * `result` message, or rejects if the attempt itself ends first (abort,
 * crash, discard) or if `onMessage` throws.
 *
 * Never lets an exception escape as an unhandled rejection from inside the
 * pump: `entry.currentHandler` always settles this promise instead of
 * throwing, so the pump loop can safely `await` it unconditionally.
 */
function waitForTurnResult(
  entry: AttemptEntry,
  onMessage: (msg: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      entry.currentHandler = null;
      entry.currentReject = null;
      fn();
    };
    entry.currentReject = (err: unknown) => settle(() => reject(err));
    entry.currentHandler = (msg: Record<string, unknown>) => {
      try {
        const result = onMessage(msg);
        if (result instanceof Promise) {
          return result.then(
            () => {
              if (msg.type === "result") settle(resolve);
            },
            (err: unknown) => settle(() => reject(err)),
          );
        }
        if (msg.type === "result") settle(resolve);
      } catch (err) {
        settle(() => reject(err));
      }
      return undefined;
    };
  });
}

/**
 * Runs for an attempt's entire lifetime: reads the SDK's message stream and
 * dispatches each message to whichever turn is currently awaiting it
 * (`entry.currentHandler`, set by `waitForTurnResult`). Messages that arrive
 * with no turn awaiting them are dropped — this shouldn't happen since only
 * one turn is ever in flight per thread, but the pump degrades safely rather
 * than throwing if it does.
 *
 * When the stream ends (subprocess exited — normal after a deliberate
 * discard, unexpected otherwise) the entry is removed from the registry and
 * any still-waiting turn is rejected, so a genuine crash surfaces as a
 * failed turn instead of a silent hang.
 */
function pumpAttempt(
  entry: AttemptEntry,
  stream: AsyncIterable<unknown>,
  registry: AttemptRegistry,
  logger: Logger,
): void {
  void (async () => {
    try {
      for await (const msg of stream) {
        await entry.currentHandler?.(msg as Record<string, unknown>);
      }
      finishPump(entry, registry, null, logger);
    } catch (err) {
      finishPump(entry, registry, err, logger);
    }
  })();
}

function finishPump(
  entry: AttemptEntry,
  registry: AttemptRegistry,
  err: unknown,
  logger: Logger,
): void {
  entry.closed = true;
  registry.removeIfCurrent(entry);
  const reject = entry.currentReject;
  entry.currentHandler = null;
  entry.currentReject = null;
  if (reject) {
    reject(err ?? new Error("attempt subprocess ended unexpectedly"));
  } else if (err) {
    logger.warn("[attempt-pump] stream ended with error and no waiting turn", {
      threadId: entry.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function transcriptHasEntries(transcriptPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(transcriptPath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

/**
 * Read the usage object from the last assistant message in the SDK session
 * JSONL. The SDK writes the real Anthropic API usage (including
 * cache_read_input_tokens) to each assistant record; the streaming result
 * message's usage field is a summarised view that may zero out cache counts.
 */
async function readLastAssistantUsage(
  transcriptPath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await fs.readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    // Scan from the end — the last assistant record is the one we want.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = lines[i];
        if (!line) continue;
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "assistant") {
          const msg = entry.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, unknown> | undefined;
          if (usage && typeof usage.output_tokens === "number") {
            return usage;
          }
        }
      } catch {
        // Malformed line — skip.
      }
    }
  } catch {
    // File missing or unreadable — fall through.
  }
  return undefined;
}

type StreamItemRef =
  | {
      id: string;
      type: "agentMessage" | "reasoning";
      buffer: string;
    }
  | {
      id: string;
      type: "toolCall";
      name: string;
      /**
       * Anthropic SDK streams a tool_use block's input as a sequence of
       * `input_json_delta` events whose `partial_json` strings concatenate
       * into the final JSON. We accumulate the raw string here and
       * JSON.parse it at content_block_stop.
       */
      partialJson: string;
    };

/**
 * Mutable tracker for the most recently completed agentMessage block in
 * the current turn. The `assistant` SDK message arrives after all of its
 * content_block_stop events; only then is `stop_reason` known. To tag the
 * trailing agentMessage block with `phase: "final_answer"` retroactively,
 * we keep its id/text so the runTurn loop can emit an `item/updated`
 * notification when `stop_reason === "end_turn"` resolves.
 */
type AgentMessageTracker = {
  lastItemId?: string;
  lastText?: string;
};

// Controls the periodic non-heartbeat `subagentActivity` progress emitter.
// `arm()` starts emitting (idempotent); `disarm()` stops (idempotent). See the
// long comment at the controller's construction site in runTurn for why this
// exists and how it keeps native-subagent turns alive through the consumer's
// idle watchdog.
type NativeActivityKind = "subagentActivity" | "toolActivity";

type SubagentActivityController = {
  arm: (kind?: NativeActivityKind, tool?: string) => void;
  disarm: () => void;
};

// Native claude_code subagent tools whose execution happens in a child process
// AFTER the tool_use block closes, with no progress bubbled to the parent
// iterator on the installed SDK version. Seeing one of these begin a tool_use
// block is our signal to arm the subagent-activity emitter. `TaskOutput` /
// `TaskStop` are control/IO ops that resolve promptly and don't need it.
const NATIVE_SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

// How often the armed emitter fires a `subagentActivity` progress notification.
// Must be comfortably below both the bridge's 30s heartbeat cadence and the
// consumer's idle budget so a subagent that starts right after a heartbeat tick
// still yields a non-heartbeat signal well inside the watchdog window.
export const SUBAGENT_ACTIVITY_INTERVAL_MS = 20_000;

/**
 * Builds the native-subagent activity emitter. `arm()` starts a periodic
 * non-heartbeat `turn/progress {kind:"subagentActivity"}` notification (no-op if
 * already armed); `disarm()` stops it (no-op if not armed). Extracted so the
 * arm/disarm/emit semantics can be unit-tested with fake timers, independent of
 * the SDK stream. See the call site in runTurn for the full rationale.
 */
export function createSubagentActivityEmitter(opts: {
  notify: (method: string, params: unknown) => void;
  threadId: string;
  turnId: string;
  onError?: (err: unknown) => void;
  intervalMs?: number;
}): SubagentActivityController {
  const intervalMs = opts.intervalMs ?? SUBAGENT_ACTIVITY_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let armedKind: NativeActivityKind = "subagentActivity";
  let armedTool: string | undefined;
  const arm = (kind: NativeActivityKind = "subagentActivity", tool?: string) => {
    armedKind = kind;
    armedTool = tool;
    if (timer) return;
    timer = setInterval(() => {
      try {
        opts.notify("turn/progress", {
          threadId: opts.threadId,
          turnId: opts.turnId,
          kind: armedKind,
          ...(armedTool ? { tool: armedTool } : {}),
        });
      } catch (activityErr) {
        opts.onError?.(activityErr);
      }
    }, intervalMs);
    timer.unref?.();
  };
  const disarm = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };
  return { arm, disarm };
}

function handleStreamEvent(
  msg: Record<string, unknown>,
  blocks: Map<number, StreamItemRef>,
  turn: ActiveTurn,
  meta: ThreadMeta,
  notify: (method: string, params: unknown) => void,
  agentMessageTracker: AgentMessageTracker,
  subagentActivity: SubagentActivityController,
): void {
  const evt = msg.event as Record<string, unknown> | undefined;
  if (!evt || typeof evt.type !== "string") return;

  switch (evt.type) {
    case "content_block_start": {
      const idx = numField(evt, "index");
      const block = evt.content_block as Record<string, unknown> | undefined;
      if (idx === undefined || !block) return;
      const kind = typeof block.type === "string" ? block.type : "";
      if (kind === "text") {
        const item: StreamItemRef = { id: randomUUID(), type: "agentMessage", buffer: "" };
        blocks.set(idx, item);
        notify("item/started", {
          threadId: meta.id,
          turnId: turn.turnId,
          item: makeAgentMessageItem(item.id, ""),
        });
      } else if (kind === "thinking") {
        const item: StreamItemRef = { id: randomUUID(), type: "reasoning", buffer: "" };
        blocks.set(idx, item);
        notify("item/started", {
          threadId: meta.id,
          turnId: turn.turnId,
          item: makeReasoningItem(item.id, ""),
        });
      } else if (kind === "tool_use") {
        // Native Claude SDK tool call (Bash, Read, Edit, Write, etc.).
        // Use the block's own id so item/started and item/completed
        // refer to the same logical thing the SDK already knows about.
        // Project this onto codex's `toolCall` item type so the bridge
        // projector recognizes it as a tool item (isToolItem).
        const blockId = typeof block.id === "string" ? block.id : randomUUID();
        const blockName = typeof block.name === "string" ? block.name : "unknown";
        const item: StreamItemRef = {
          id: blockId,
          type: "toolCall",
          name: blockName,
          partialJson: "",
        };
        blocks.set(idx, item);
        notify("item/started", {
          threadId: meta.id,
          turnId: turn.turnId,
          item: makeNativeToolCallItem({
            id: blockId,
            tool: blockName,
            args: null,
            status: "running",
          }),
        });
      }
      // tool_result blocks: not surfaced here; the SDK handles tool
      // result accounting internally and the result text reappears in
      // the next agentMessage block downstream.
      break;
    }
    case "content_block_delta": {
      const idx = numField(evt, "index");
      if (idx === undefined) return;
      const ref = blocks.get(idx);
      if (!ref) return;
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (!delta) return;
      const deltaKind = typeof delta.type === "string" ? delta.type : "";
      if (ref.type === "agentMessage" && deltaKind === "text_delta" && typeof delta.text === "string") {
        ref.buffer += delta.text;
        notify("item/agentMessage/delta", {
          threadId: meta.id,
          turnId: turn.turnId,
          itemId: ref.id,
          delta: delta.text,
        });
      } else if (ref.type === "reasoning" && deltaKind === "thinking_delta" && typeof delta.thinking === "string") {
        ref.buffer += delta.thinking;
        // Codex uses item/reasoning/delta for thinking streams. Keep parity.
        notify("item/reasoning/delta", {
          threadId: meta.id,
          turnId: turn.turnId,
          itemId: ref.id,
          delta: delta.thinking,
        });
      } else if (
        ref.type === "toolCall" &&
        deltaKind === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        // Accumulate the streaming tool-input JSON. The Anthropic SDK
        // doesn't define a codex-style per-arg delta event we can
        // mirror, so we just store the partial and parse on stop.
        ref.partialJson += delta.partial_json;
      }
      break;
    }
    case "content_block_stop": {
      const idx = numField(evt, "index");
      if (idx === undefined) return;
      const ref = blocks.get(idx);
      if (!ref) return;
      blocks.delete(idx);
      let finalItem: ThreadItem;
      switch (ref.type) {
        case "agentMessage":
          // Default every agentMessage block to phase: "commentary".
          // The trailing block of an assistant message with
          // stop_reason === "end_turn" gets retroactively retagged
          // "final_answer" via an item/updated emitted in the
          // `assistant` case in runTurn. Bridges can therefore trust:
          //   - phase: "commentary" => intermediate prose, route as
          //     preamble/transcript content.
          //   - phase: "final_answer" => the turn's deliverable reply.
          finalItem = makeAgentMessageItem(ref.id, ref.buffer, "commentary");
          agentMessageTracker.lastItemId = ref.id;
          agentMessageTracker.lastText = ref.buffer;
          break;
        case "reasoning":
          finalItem = makeReasoningItem(ref.id, ref.buffer);
          break;
        case "toolCall": {
          // Parse the accumulated input JSON. Empty string is valid
          // (no-arg tool); JSON.parse on "" throws so guard.
          let args: unknown = null;
          if (ref.partialJson.trim().length > 0) {
            try {
              args = JSON.parse(ref.partialJson);
            } catch {
              // Malformed JSON shouldn't crash the turn; surface raw text.
              args = { _rawPartialJson: ref.partialJson };
            }
          }
          // Surface an item/updated mid-stream so the bridge can re-emit
          // the tool with full args before the call completes. The initial
          // item/started fired at content_block_start with args:null (the
          // LLM hadn't streamed the input JSON yet), so channel renderers
          // showed "🛠️ Bash" with no command detail. With this update they
          // can refresh to "🛠️ Bash <command>" once the input is resolved
          // — matching codex's per-tool command line.
          const updatedItem = makeNativeToolCallItem({
            id: ref.id,
            tool: ref.name,
            args,
            status: "running",
          });
          notify("item/updated", {
            threadId: meta.id,
            turnId: turn.turnId,
            item: updatedItem,
          });
          finalItem = makeNativeToolCallItem({
            id: ref.id,
            tool: ref.name,
            args,
            // Status is "completed" from the LLM's perspective (it finished
            // describing the tool call). Actual execution happens inside
            // the SDK between turns; the result reappears in the next
            // assistant text block downstream.
            status: "completed",
          });
          // The SDK is about to EXECUTE this tool, and on the installed SDK
          // version that execution emits nothing to this iterator until it
          // finishes — the block events only bracket the model *describing*
          // the call. Arm the activity emitter NOW — on block *stop*, not
          // start, because the silent window begins only after the model
          // finishes describing the call. The main loop disarms it the
          // instant the next real stream event arrives. Subagents
          // (`Agent`/`Task`) keep their dedicated kind (the consumer's task
          // mirror + wider idle budget key on it); every other native tool
          // gets kind:"toolActivity" so consumers can prove tool-execution
          // liveness to their own watchdogs during long single calls
          // (a multi-minute Bash build was previously indistinguishable
          // from a hang — see openclaw/openclaw#86655 CHANGELOG).
          if (ref.name && NATIVE_SUBAGENT_TOOL_NAMES.has(ref.name)) {
            subagentActivity.arm("subagentActivity", ref.name);
          } else {
            subagentActivity.arm("toolActivity", ref.name || undefined);
          }
          break;
        }
      }
      turn.items.push(finalItem);
      notify("item/completed", {
        threadId: meta.id,
        turnId: turn.turnId,
        item: finalItem,
      });
      break;
    }
    // message_start, message_delta, message_stop carry turn-level metadata
    // we don't need at this layer — the SDK's `result` message gives us the
    // authoritative end-of-turn signal.
    default:
      break;
  }
}

function numField(obj: Record<string, unknown>, name: string): number | undefined {
  const v = obj[name];
  return typeof v === "number" ? v : undefined;
}

type AgentMessagePhase = "commentary" | "final_answer" | null;

function makeAgentMessageItem(
  id: string,
  text: string,
  phase: AgentMessagePhase = null,
): ThreadItem {
  return {
    id,
    type: "agentMessage",
    title: null,
    status: null,
    name: null,
    tool: null,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text,
    changes: [],
    // Codex's normalizeThreadItem injects these defaults for agentMessage —
    // mirror them so the response validates against codex's ThreadItem
    // schema without round-trip normalization. `phase` classifies the
    // message as interim commentary (intermediate prose / progress
    // narration) or final_answer (the assistant's terminal reply for the
    // turn). Bridges use this to decide whether a block belongs in the
    // in-channel transcript (preamble) or as the deliverable reply.
    phase,
    memoryCitation: null,
  };
}

function makeDynamicToolCallItem(opts: {
  callId: string;
  tool: string;
  args: unknown;
  status: "running" | "completed" | "failed";
  contentItems: DynamicToolCallOutputContentItem[] | null;
  success: boolean | null;
  durationMs: number | null;
}): ThreadItem {
  // codex's normalizeThreadItem defaults for dynamicToolCall items:
  // {namespace: null, arguments: null, status: "completed", contentItems: null,
  //  success: null, durationMs: null, ...}
  return {
    id: opts.callId,
    type: "dynamicToolCall",
    title: null,
    status: opts.status,
    name: opts.tool,
    tool: opts.tool,
    server: "openclaw",
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text: "",
    changes: [],
    namespace: null,
    arguments: (opts.args ?? null) as ThreadItem["arguments"],
    contentItems: opts.contentItems,
    success: opts.success,
    durationMs: opts.durationMs,
  };
}

function coerceToolResponse(raw: unknown): DynamicToolCallResponse {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const items = Array.isArray(obj.contentItems) ? obj.contentItems : [];
    const success = obj.success !== false; // default true if unspecified
    return {
      contentItems: items as DynamicToolCallOutputContentItem[],
      success,
      diagnosticTerminalType:
        typeof obj.diagnosticTerminalType === "string" ? obj.diagnosticTerminalType : undefined,
    };
  }
  return {
    contentItems: [{ type: "inputText", text: "Tool returned an unrecognized response shape." }],
    success: false,
  };
}

/**
 * Native Claude SDK tool calls (Bash, Read, Edit, etc.) are projected
 * onto codex's `toolCall` item type so the bridge projector recognizes
 * them via isToolItem and fires stream:"tool" events to channel
 * renderers (Discord progress mode, etc.). Mirrors makeDynamicToolCallItem
 * but for the native-SDK side; we don't carry contentItems/success/
 * durationMs because the SDK handles execution accounting internally
 * and the result reappears in the next assistant text block.
 */
function makeNativeToolCallItem(opts: {
  id: string;
  tool: string;
  args: unknown;
  status: "running" | "completed" | "failed";
}): ThreadItem {
  return {
    id: opts.id,
    type: "toolCall",
    title: null,
    status: opts.status,
    name: opts.tool,
    tool: opts.tool,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text: "",
    changes: [],
    namespace: null,
    arguments: (opts.args ?? null) as ThreadItem["arguments"],
    contentItems: null,
    success: null,
    durationMs: null,
  };
}

function makeReasoningItem(id: string, text: string): ThreadItem {
  return {
    id,
    type: "reasoning",
    title: null,
    status: null,
    name: null,
    tool: null,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text,
    changes: [],
    // Codex's normalize injects these for reasoning items.
    summary: [],
    content: [],
  };
}
