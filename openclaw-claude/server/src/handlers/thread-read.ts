/**
 * `thread/read` handler. Reconstructs conversation content from the
 * persisted messages.jsonl for display (e.g. a Sessions page transcript
 * view) — this is a read of OUR OWN storage, not a live SDK call.
 *
 * Scope note (v1): messages.jsonl carries the Claude Agent SDK's raw
 * per-message entries (`user`/`assistant`, each with Anthropic content
 * blocks) interleaved with OpenClaw-harness bookkeeping entries
 * (`queue-operation`, `ai-title`, `last-prompt`, `mode`, `pr-link`, etc. —
 * verified against real transcripts on disk). This handler surfaces the
 * conversational content (text + tool_use blocks) as a single synthetic
 * completed Turn; it does not yet reconstruct codex's real turn boundaries
 * or correlate tool_result blocks back onto their originating tool_use item.
 * Good enough to answer "what was said in this thread"; full turn/tool-call
 * fidelity is a follow-up once a consumer needs it.
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type ThreadItem,
  type ThreadReadParams,
  type ThreadReadResponse,
  type Turn,
} from "../protocol.js";
import { RpcError } from "../server.js";
import { derivePreview, metaToThread } from "../thread-mapper.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";

const THREAD_NOT_FOUND_CODE = -32004;

// Harness bookkeeping entry types mixed into the same JSONL that aren't part
// of the conversation itself — see scope note above.
const NON_CONVERSATIONAL_ENTRY_TYPES = new Set([
  "queue-operation",
  "ai-title",
  "last-prompt",
  "mode",
  "pr-link",
  "system",
  "attachment",
]);

export function createThreadReadHandler(threadStore: ThreadStore, logger: Logger) {
  return async function handleThreadRead(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const meta = await threadStore.readMeta(params.threadId);
    if (!meta) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }

    const turns = params.includeTurns === false ? [] : await reconstructTurns(threadStore.messagesPath(meta.id));

    const response: ThreadReadResponse = {
      thread: metaToThread(meta, {
        status: { type: "idle" },
        turns,
        preview: await derivePreview(threadStore.messagesPath(meta.id)),
      }),
    };
    logger.info("[thread/read] read", { threadId: meta.id, itemCount: turns[0]?.items.length ?? 0 });
    return response as unknown as JsonValue;
  };
}

function parseParams(raw: JsonValue | undefined): ThreadReadParams {
  if (!isJsonObject(raw) || typeof raw.threadId !== "string") {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/read requires { threadId: string }");
  }
  return raw as ThreadReadParams;
}

async function reconstructTurns(messagesPath: string): Promise<Turn[]> {
  let raw: string;
  try {
    raw = await fs.readFile(messagesPath, "utf8");
  } catch {
    return [];
  }

  const items: ThreadItem[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const entryType = entry.type;
    if (typeof entryType !== "string" || NON_CONVERSATIONAL_ENTRY_TYPES.has(entryType)) continue;
    if (entryType !== "user" && entryType !== "assistant") continue;
    items.push(...itemsFromEntry(entry, entryType));
  }

  if (items.length === 0) return [];
  return [
    {
      id: randomUUID(),
      status: "completed",
      items,
      itemsView: "full",
    },
  ];
}

function itemsFromEntry(entry: Record<string, unknown>, role: "user" | "assistant"): ThreadItem[] {
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim() ? [textItem(content, role)] : [];
  }
  if (!Array.isArray(content)) return [];

  const out: ThreadItem[] = [];
  for (const block of content) {
    if (!isJsonObject(block)) continue;
    const blockType = block.type;
    if (blockType === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push(textItem(block.text, role));
    } else if (blockType === "tool_use" && typeof block.name === "string") {
      out.push(toolCallItem(block, block.name));
    }
    // "thinking" and "tool_result" blocks are intentionally skipped in this
    // v1 — see the module-level scope note.
  }
  return out;
}

function textItem(text: string, role: "user" | "assistant"): ThreadItem {
  return {
    id: randomUUID(),
    type: role === "assistant" ? "agentMessage" : "userMessage",
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
  };
}

function toolCallItem(block: Record<string, unknown>, name: string): ThreadItem {
  return {
    id: typeof block.id === "string" ? block.id : randomUUID(),
    type: "toolCall",
    title: name,
    status: null,
    name,
    tool: name,
    server: null,
    command: null,
    cwd: null,
    query: null,
    arguments: (block.input as JsonValue) ?? null,
    aggregatedOutput: null,
    text: "",
    changes: [],
  };
}
