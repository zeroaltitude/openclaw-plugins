/**
 * `SessionStore` adapter for `@anthropic-ai/claude-agent-sdk`. The SDK writes
 * transcript entries to our adapter; we mirror them to `messages.jsonl` in the
 * thread directory. Reads happen at resume time.
 *
 * The SDK uses opaque `SessionStoreEntry` objects ({type, uuid?, timestamp?,
 * ...}); we just JSON.stringify them one per line. Idempotency by `uuid` is
 * the adapter's responsibility per the SDK contract.
 *
 * `projectKey` from the SDK is unused here — our store is flat-by-threadId.
 * Future grouping can be added without breaking the SDK side.
 */

import { promises as fs } from "node:fs";

import type { ThreadStore } from "./thread-store.js";
import type { Logger } from "./transport.js";

// Structural copy of the SDK's SessionStoreEntry / SessionKey shapes — we
// don't import them to keep this file independent of the SDK's type surface.
type SessionKey = { projectKey: string; sessionId: string; subpath?: string };
type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [k: string]: unknown };

export class OpenClawSessionStore {
  constructor(
    private readonly threadStore: ThreadStore,
    private readonly logger: Logger,
  ) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const path = this.transcriptPath(key);
    const seen = await this.loadUuidIndex(path);
    const filtered: SessionStoreEntry[] = [];
    for (const entry of entries) {
      if (entry.uuid && seen.has(entry.uuid)) continue;
      filtered.push(entry);
      if (entry.uuid) seen.add(entry.uuid);
    }
    if (filtered.length === 0) return;
    const text = filtered.map((e) => JSON.stringify(e)).join("\n") + "\n";
    try {
      await fs.appendFile(path, text, "utf8");
    } catch (err) {
      // mkdir-then-append in case the thread dir didn't exist (shouldn't
      // happen since thread/start creates it, but be defensive).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.mkdir(this.threadStore.threadDir(key.sessionId), { recursive: true });
        await fs.appendFile(path, text, "utf8");
        return;
      }
      this.logger.warn("[session-store] append failed", {
        sessionId: key.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const path = this.transcriptPath(key);
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.logger.warn("[session-store] load failed", {
        sessionId: key.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    const entries: SessionStoreEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as SessionStoreEntry);
      } catch (err) {
        this.logger.warn("[session-store] dropping unparseable transcript line", {
          sessionId: key.sessionId,
          preview: trimmed.slice(0, 200),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return entries;
  }

  async delete(key: SessionKey): Promise<void> {
    await this.threadStore.deleteThread(key.sessionId);
  }

  private transcriptPath(key: SessionKey): string {
    // Subpath handles subagent transcripts; for the main transcript we use
    // the canonical messages.jsonl. Subagent paths go into sibling files.
    const base = this.threadStore.messagesPath(key.sessionId);
    return key.subpath ? `${base}.${sanitizeSubpath(key.subpath)}` : base;
  }

  private async loadUuidIndex(path: string): Promise<Set<string>> {
    const seen = new Set<string>();
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return seen;
      throw err;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as SessionStoreEntry;
        if (entry.uuid) seen.add(entry.uuid);
      } catch {
        // Skip unparseable lines (load() will warn separately).
      }
    }
    return seen;
  }
}

function sanitizeSubpath(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, "_");
}
