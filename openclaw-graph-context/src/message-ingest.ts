/**
 * Shared per-message → node/edge conversion.
 *
 * Both the file-based ingester (ingest.ts, reading persisted JSONL session
 * files) and the live hook-driven ingester (live-ingest.ts, reading
 * `agent_end` plugin hook payloads) call `ingestMessage()` for every message
 * they see. Keeping this logic in one place guarantees both paths compute
 * identical node/edge ids for the same message content — no drift between
 * what gets written live and what a later full reingest reconstructs from
 * disk.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { NodeType } from "./db.js";
import { insertEdge, upsertNode } from "./db.js";

export function shortHash(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function extractText(content: unknown, maxChars: number): string {
  if (typeof content === "string") return content.slice(0, maxChars);
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === "string") return c;
        if (!c || typeof c !== "object") return "";
        const block = c as Record<string, unknown>;
        if (typeof block.text === "string") return block.text;
        // Skip toolCall blocks — they are now separate nodes, not embedded text
        if (block.type === "toolCall") return "";
        // toolResult block — content may be string or array
        if (block.type === "toolResult") {
          return extractText(block.content, maxChars);
        }
        if (block.type === "thinking" && typeof block.thinking === "string") {
          return `<thinking:${block.thinking.slice(0, 100)}>`;
        }
        return "";
      })
      .join(" ")
      .trim()
      .slice(0, maxChars);
  }
  return "";
}

/** Extract tool calls from an assistant message's content blocks. */
export interface ToolCallBlock {
  toolCallId: string;
  name: string;
  args: string; // JSON-stringified, truncated
}

export function extractToolCalls(content: unknown, maxArgChars = 500): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCallBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as Record<string, unknown>;
    if (block.type !== "toolCall" || typeof block.name !== "string") continue;
    const id = typeof block.id === "string" ? block.id : "";
    const args = block.arguments ? JSON.stringify(block.arguments).slice(0, maxArgChars) : "";
    calls.push({ toolCallId: id, name: block.name, args });
  }
  return calls;
}

export function estimateTokens(text: string): number {
  // ~4 chars per token rough estimate
  return Math.ceil(text.length / 4);
}

/**
 * A message-shaped object. Both the persisted JSONL transcript entries
 * (`entry.message`) and the plugin hook `messages` arrays (built by
 * `buildCliHookUserMessage`/`buildCliHookAssistantMessage` in OpenClaw core)
 * use this same shape: `role`, `content` (string or content-block array),
 * `timestamp`, optional `model`, and toolResult metadata under `meta` (or,
 * in legacy JSONL entries, directly on the message).
 */
export interface RawMessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  model?: string;
  toolCallId?: string; // legacy: some formats put it at top level
  meta?: {
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    exitCode?: number;
  };
}

export interface MessageIngestState {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  sessionNodeId: string;
  /** Last node in the sequence flow; null means "the session node itself". */
  prevNodeId: string | null;
  /** toolCallId -> tool_call node id, for correlating a later toolResult's returns edge. */
  toolCallNodeById: Map<string, string>;
  maxContentChars: number;
}

export interface MessageIngestResult {
  prevNodeId: string | null;
  nodesAdded: number;
  edgesAdded: number;
}

/**
 * Convert one message into node(s) + edge(s) and advance the sequence chain.
 * Idempotent (upsertNode/insertEdge are both safe to call repeatedly for the
 * same id), so callers may re-process a message without risk of duplication.
 */
export function ingestMessage(
  db: Database.Database,
  msg: RawMessageLike,
  entryId: string,
  msgTs: number,
  state: MessageIngestState,
): MessageIngestResult {
  const { agentId, sessionId, sessionKey, sessionNodeId, toolCallNodeById, maxContentChars } = state;
  let prevNodeId = state.prevNodeId;
  let nodesAdded = 0;
  let edgesAdded = 0;

  // --- toolResult entries → tool_result nodes ---
  if (msg.role === "toolResult") {
    // toolCallId and toolName live in msg.meta (current format) or msg directly (legacy)
    const toolCallId = msg.meta?.toolCallId ?? msg.toolCallId ?? "";
    const toolName = msg.meta?.toolName ?? "";

    // content_text: prefer actual content, fall back to labeling by tool name
    const rawText = extractText(msg.content, maxContentChars * 2);
    const contentText = rawText || toolName ? (rawText || `[${toolName} result]`).slice(0, maxContentChars) : "";
    const tokens = estimateTokens(rawText);

    // Collect exit code from meta or content blocks
    const exitCode =
      msg.meta?.exitCode ??
      (() => {
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b && typeof b === "object") {
              const details = (b as Record<string, unknown>).details;
              if (details && typeof details === "object") {
                const ec = (details as Record<string, unknown>).exitCode;
                if (ec !== undefined) return ec;
              }
            }
          }
        }
        return undefined;
      })();

    const trProps: Record<string, unknown> = { toolCallId };
    if (toolName) trProps.name = toolName;
    if (msg.meta?.isError) trProps.isError = true;
    if (exitCode !== undefined) trProps.exitCode = exitCode;

    const trNodeId = `tool_result:${sessionId}:${entryId}`;
    upsertNode(db, {
      id: trNodeId,
      type: "tool_result" as NodeType,
      agent_id: agentId,
      session_id: sessionId,
      session_key: sessionKey,
      ts: msgTs,
      content_text: contentText,
      content_tokens: tokens,
      properties: JSON.stringify(trProps),
    });
    nodesAdded++;

    const seqSrc = prevNodeId ?? sessionNodeId;
    insertEdge(db, { id: shortHash("seq", seqSrc, trNodeId), src: seqSrc, dst: trNodeId, type: "sequence", weight: 1 });
    edgesAdded++;

    if (toolCallId && toolCallNodeById.has(toolCallId)) {
      const tcNodeId = toolCallNodeById.get(toolCallId)!;
      insertEdge(db, { id: shortHash("returns", tcNodeId, trNodeId), src: tcNodeId, dst: trNodeId, type: "returns", weight: 1 });
      edgesAdded++;
    }

    prevNodeId = trNodeId;
    return { prevNodeId, nodesAdded, edgesAdded };
  }

  // --- user / assistant message nodes ---
  if (msg.role !== "user" && msg.role !== "assistant") {
    return { prevNodeId, nodesAdded, edgesAdded };
  }

  const rawText = extractText(msg.content, maxContentChars * 2);
  const contentText = rawText.slice(0, maxContentChars);
  const tokens = estimateTokens(rawText);

  const props: Record<string, unknown> = {};
  if (msg.model) props.model = msg.model;

  const msgNodeId = `msg:${sessionId}:${entryId}`;
  upsertNode(db, {
    id: msgNodeId,
    type: "message" as NodeType,
    agent_id: agentId,
    session_id: sessionId,
    session_key: sessionKey,
    role: msg.role as "user" | "assistant",
    ts: msgTs,
    content_text: contentText,
    content_tokens: tokens,
    properties: Object.keys(props).length > 0 ? JSON.stringify(props) : undefined,
  });
  nodesAdded++;

  // sequence edge from prev node (or session node if first)
  const seqSrc = prevNodeId ?? sessionNodeId;
  insertEdge(db, { id: shortHash("seq", seqSrc, msgNodeId), src: seqSrc, dst: msgNodeId, type: "sequence", weight: 1 });
  edgesAdded++;
  prevNodeId = msgNodeId;

  // --- For assistant messages: expand toolCall blocks into tool_call nodes ---
  if (msg.role === "assistant") {
    const toolCalls = extractToolCalls(msg.content);
    for (const tc of toolCalls) {
      const tcNodeId = tc.toolCallId ? `tool_call:${tc.toolCallId}` : shortHash("tool_call", sessionId, entryId, tc.name);

      upsertNode(db, {
        id: tcNodeId,
        type: "tool_call" as NodeType,
        agent_id: agentId,
        session_id: sessionId,
        session_key: sessionKey,
        ts: msgTs,
        content_text: `${tc.name}(${tc.args})`.slice(0, maxContentChars),
        content_tokens: estimateTokens(tc.args),
        properties: JSON.stringify({ toolCallId: tc.toolCallId, name: tc.name }),
      });
      nodesAdded++;

      // invokes edge: message → tool_call
      insertEdge(db, { id: shortHash("invokes", msgNodeId, tcNodeId), src: msgNodeId, dst: tcNodeId, type: "invokes", weight: 1 });
      edgesAdded++;

      // Register for returns edge correlation
      if (tc.toolCallId) toolCallNodeById.set(tc.toolCallId, tcNodeId);
    }
  }

  return { prevNodeId, nodesAdded, edgesAdded };
}
