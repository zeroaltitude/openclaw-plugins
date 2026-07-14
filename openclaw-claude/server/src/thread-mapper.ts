/**
 * Shared ThreadMeta -> wire Thread construction, used by every handler that
 * returns a Thread (start, resume, fork, list, read). Kept in one place so
 * new fields (e.g. `name`) only need adding once.
 */

import { promises as fs } from "node:fs";

import type { Thread, ThreadStatus, Turn } from "./protocol.js";
import type { ThreadMeta } from "./thread-store.js";

export function metaToThread(meta: ThreadMeta, opts: { status: ThreadStatus; turns: Turn[]; preview: string }): Thread {
  return {
    id: meta.id,
    sessionId: meta.sessionId,
    cliVersion: meta.cliVersion,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    cwd: meta.cwd,
    ephemeral: meta.ephemeral,
    modelProvider: meta.modelProvider,
    preview: opts.preview,
    source: meta.source,
    status: opts.status,
    turns: opts.turns,
    name: meta.name ?? null,
    forkedFromId: meta.forkedFromId ?? null,
    archived: meta.archived ?? false,
  };
}

/**
 * Preview is "usually the first user message" per the codex schema. We scan
 * the JSONL for the first entry with role=user and a text body.
 */
export async function derivePreview(messagesPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(messagesPath, "utf8");
  } catch {
    return "";
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const text = extractUserText(entry);
      if (text) return text.slice(0, 200);
    } catch {
      continue;
    }
  }
  return "";
}

function extractUserText(entry: Record<string, unknown>): string | null {
  // SDK entry shapes vary; defensively look at common locations.
  if (entry.type === "user" || entry.role === "user") {
    const message = (entry.message ?? entry.content) as unknown;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) {
      for (const block of message) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
      }
    }
    if (message && typeof message === "object") {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
    }
  }
  return null;
}
