/**
 * Blocked Write Store — persists blocked memory file writes to disk.
 *
 * When tainted context attempts to write to memory files (MEMORY.md, SOUL.md,
 * memory/*.md, etc.), the write is blocked but the content is saved here
 * so it can be reviewed and committed later.
 *
 * Files are stored at: <workspaceDir>/.provenance/blocked-writes/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import type { TrustLevel } from "./trust-levels.js";

export interface BlockedWrite {
  /** Unique ID for this blocked write */
  id: string;
  /** Original target path the write was intended for */
  targetPath: string;
  /** The content that would have been written */
  content: string;
  /** Whether this was an edit (partial) or full write */
  operation: "write" | "edit";
  /** For edits: the old text being replaced */
  oldText?: string;
  /** The taint level that triggered the block */
  taintLevel: TrustLevel;
  /** Human-readable reason for blocking */
  reason: string;
  /** ISO-8601 timestamp */
  blockedAt: string;
  /** Session key where the block occurred */
  sessionKey: string;
}

export class BlockedWriteStore {
  private dir: string;

  constructor(workspaceDir: string) {
    this.dir = join(workspaceDir, ".provenance", "blocked-writes");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * Save a blocked write to disk.
   * Returns the ID and file path of the saved write.
   */
  save(write: Omit<BlockedWrite, "id">): { id: string; filePath: string } {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: BlockedWrite = { ...write, id };

    const filename = `${id}.json`;
    const filePath = join(this.dir, filename);

    try {
      writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
    } catch {
      // Best effort — don't crash the plugin on write failure
    }

    return { id, filePath };
  }

  /**
   * List all blocked writes (for review).
   */
  list(): BlockedWrite[] {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
      return files
        .map((f) => {
          try {
            const raw = readFileSync(join(this.dir, f), "utf-8");
            return JSON.parse(raw) as BlockedWrite;
          } catch {
            return null;
          }
        })
        .filter((w): w is BlockedWrite => w !== null)
        .sort((a, b) => a.blockedAt.localeCompare(b.blockedAt));
    } catch {
      return [];
    }
  }

  /**
   * Get a specific blocked write by ID.
   */
  get(id: string): BlockedWrite | undefined {
    const filePath = join(this.dir, `${id}.json`);
    try {
      if (!existsSync(filePath)) return undefined;
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as BlockedWrite;
    } catch {
      return undefined;
    }
  }

  /**
   * Remove a blocked write (after it's been committed or discarded).
   */
  remove(id: string): boolean {
    const filePath = join(this.dir, `${id}.json`);
    try {
      if (!existsSync(filePath)) return false;
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all blocked writes.
   */
  clearAll(): number {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          unlinkSync(join(this.dir, f));
        } catch {
          // best effort
        }
      }
      return files.length;
    } catch {
      return 0;
    }
  }
}
