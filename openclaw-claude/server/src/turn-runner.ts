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
  buildDynamicToolsMcpServer,
  type DynamicToolCallResponse,
  type ToolCallBridge,
} from "./dynamic-tools.js";
import { formatRateLimitMessage, parseAnthropicRateLimitError } from "./rate-limits.js";
import {
  thinkingBudgetForEffort,
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
  collaborationMode?: TurnCollaborationMode | null;
  modelOverride?: string;
  sessionStore: OpenClawSessionStore;
  threadStore: ThreadStore;
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
  const { meta, turn, input, effort, sessionStore, notify, logger } = args;
  const model = args.modelOverride ?? meta.model;
  // Build the initial user message and seed a controllable queue. The queue
  // is closed immediately after the initial push so the SDK's iterator
  // exhausts cleanly — the SDK consumes input eagerly and blocks the whole
  // generation pipeline if the iterable doesn't terminate. turn/steer
  // therefore arrives at an already-closed queue and is rejected with a
  // helpful "no open input queue" error. True mid-turn steering would need
  // SDK-level support for partial-input streaming we don't have yet.
  const initialContent = await buildContentBlocks(input);
  const inputQueue = new ControllableUserInputQueue();
  turn.inputQueue = inputQueue;
  inputQueue.push(makeSDKUserMessage(initialContent));
  inputQueue.close();

  // Map codex effort → SDK thinking config.
  const budget = thinkingBudgetForEffort(effort ?? null);
  const thinking =
    budget === null
      ? ({ type: "disabled" } as const)
      : ({ type: "enabled", budgetTokens: budget } as const);

  // `resume` is only safe when there's actual history to load — passing it
  // for a brand-new thread makes the SDK silently no-op the turn. We probe
  // the on-disk transcript and set `resume` only when it has content.
  const hasHistory = await transcriptHasEntries(args.threadStore.messagesPath(meta.id));

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

  const sdkOptions: Record<string, unknown> = {
    model,
    sessionStore: sessionStore as unknown,
    abortController: turn.abortController,
    thinking,
    includePartialMessages: true,
    // Pin the SDK's working directory to the thread's cwd so the claude_code
    // preset's native Read/Edit/Bash tools operate inside the OpenClaw
    // effective workspace, not the server process cwd. Without this, native
    // tool calls effectively escape sandboxing for filesystem access.
    ...(typeof meta.cwd === "string" && meta.cwd.length > 0 ? { cwd: meta.cwd } : {}),
    ...(mergedDisallowedNative.length > 0
      ? { disallowedTools: mergedDisallowedNative }
      : {}),
    ...(Object.keys(subagentAliases).length > 0 ? { toolAliases: subagentAliases } : {}),
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
  if (typeof meta.developerInstructions === "string" && meta.developerInstructions.trim()) {
    sdkOptions.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: meta.developerInstructions,
      excludeDynamicSections: true,
    };
  } else {
    sdkOptions.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    };
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

  if (allowAll) {
    sdkOptions.permissionMode = "bypassPermissions";
  } else {
    sdkOptions.permissionMode = "default";
    sdkOptions.canUseTool = buildCanUseTool({
      ctx: { threadId: meta.id, turnId: turn.turnId },
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
  const dynamicTools = meta.dynamicTools ?? [];
  if (dynamicTools.length > 0) {
    const bridge: ToolCallBridge = async ({ ctx, callId, tool, args: toolArgs }) => {
      const response = await args.requestClient(
        "item/tool/call",
        {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          callId,
          tool,
          arguments: (toolArgs ?? null) as JsonValue,
        },
        {
          signal: turn.abortController.signal,
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
      onCallStart: ({ tool, callId, args: toolArgs, ctx }) => {
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
        turn.items.push(item);
        args.notify("item/started", {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          item,
        });
      },
      onCallEnd: ({ tool, callId, ctx, response, durationMs }) => {
        const finalized = makeDynamicToolCallItem({
          callId,
          tool,
          args: itemByCallId.get(callId)?.arguments ?? null,
          status: response.success ? "completed" : "failed",
          contentItems: response.contentItems,
          success: response.success,
          durationMs,
        });
        // Replace the in-progress item in the turn's items list.
        const idx = turn.items.findIndex((i) => i.id === finalized.id);
        if (idx >= 0) turn.items[idx] = finalized;
        else turn.items.push(finalized);
        itemByCallId.set(callId, finalized);
        args.notify("item/completed", {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          item: finalized,
        });
      },
      logger,
    });
    handle.ctxRef.current = { threadId: meta.id, turnId: turn.turnId };
    mcpServers.openclaw = {
      type: "sdk",
      name: "openclaw",
      instance: handle.instance,
    };
  }
  if (Object.keys(mcpServers).length > 0) {
    sdkOptions.mcpServers = mcpServers;
  }

  notify("turn/started", { threadId: meta.id, turnId: turn.turnId });

  const blocks = new Map<number, StreamItemRef>();

  try {
    // Cast — SDK options surface is rich and the runtime accepts our subset.
    const stream = query({ prompt: inputQueue.iterate() as never, options: sdkOptions as never });

    for await (const msg of stream as AsyncIterable<unknown>) {
      const m = msg as Record<string, unknown>;
      switch (m.type) {
        case "stream_event":
          handleStreamEvent(m, blocks, turn, meta, notify);
          break;
        case "assistant":
          // Coalesced full message; our stream events already produced the
          // items. Nothing extra to emit here.
          break;
        case "result":
          // Terminal — captured outside the loop via the for-await exit.
          break;
        case "system": {
          // Permission denials and other system events will be wired in phase 7.
          // Until then, leave a debug breadcrumb for visibility.
          logger.debug("[turn-runner] system event", { subtype: m.subtype });
          break;
        }
        default:
          // Unknown SDK event types (the SDK ships new ones regularly). Log
          // at debug level — they're not errors, just unsupported here.
          logger.debug("[turn-runner] unhandled SDK event", { type: m.type });
      }
      if (turn.abortController.signal.aborted) break;
    }

    const completedAtMs = Date.now();
    const aborted = turn.abortController.signal.aborted;
    const status = aborted ? "interrupted" : "completed";
    turn.status = status;
    inputQueue.close();
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
    inputQueue.close();
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

function handleStreamEvent(
  msg: Record<string, unknown>,
  blocks: Map<number, StreamItemRef>,
  turn: ActiveTurn,
  meta: ThreadMeta,
  notify: (method: string, params: unknown) => void,
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
          finalItem = makeAgentMessageItem(ref.id, ref.buffer);
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

function makeAgentMessageItem(id: string, text: string): ThreadItem {
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
    // schema without round-trip normalization.
    phase: null,
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
