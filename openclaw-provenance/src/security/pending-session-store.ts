/**
 * Pending Session Store
 *
 * Manages session saves that are awaiting user approval due to tainted content.
 * When a user types /new with a tainted session, the session save is deferred
 * until the user explicitly approves it.
 */

import { existsSync, mkdirSync, renameSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { TrustLevel } from "./trust-levels.js";

export interface PendingSessionSave {
  sessionKey: string;
  taint: TrustLevel;
  reason: string;
  requestedAt: number;
  code: string;
  expiresAt: number;
  tempPath: string;     // .provenance/pending-saves/...
  finalPath: string;    // memory/YYYY-MM-DD.md
}

export class PendingSessionStore {
  private pendingDir: string;
  private pending = new Map<string, PendingSessionSave>();  // code -> save

  constructor(workspaceDir: string) {
    this.pendingDir = join(workspaceDir, ".provenance", "pending-saves");
    if (!existsSync(this.pendingDir)) {
      mkdirSync(this.pendingDir, { recursive: true });
    }
  }

  /**
   * Create a pending session save.
   * Returns approval code.
   */
  createPending(
    sessionKey: string,
    taint: TrustLevel,
    reason: string,
    sessionContent: string,
    finalPath: string,
    ttlMs: number
  ): string {
    const code = randomBytes(4).toString("hex");
    const tempPath = join(this.pendingDir, `${Date.now()}-${code}.md`);

    // Write session content to temp location
    writeFileSync(tempPath, sessionContent, "utf-8");

    this.pending.set(code, {
      sessionKey,
      taint,
      reason,
      requestedAt: Date.now(),
      code,
      expiresAt: Date.now() + ttlMs,
      tempPath,
      finalPath,
    });

    return code;
  }

  /**
   * Register a pending session save without writing the file
   * (file will be written by external handler, e.g., session-memory hook).
   * Returns the code and temp path.
   */
  registerPending(
    code: string,
    sessionKey: string,
    taint: TrustLevel,
    reason: string,
    tempPath: string,
    finalPath: string,
    ttlMs: number
  ): void {
    this.pending.set(code, {
      sessionKey,
      taint,
      reason,
      requestedAt: Date.now(),
      code,
      expiresAt: Date.now() + ttlMs,
      tempPath,
      finalPath,
    });
  }

  /**
   * Approve and move pending save to memory.
   */
  approve(code: string): { ok: boolean; reason?: string; finalPath?: string } {
    const save = this.pending.get(code);
    if (!save) {
      return { ok: false, reason: "Invalid approval code" };
    }

    if (Date.now() > save.expiresAt) {
      this.pending.delete(code);
      if (existsSync(save.tempPath)) {
        rmSync(save.tempPath);
      }
      return { ok: false, reason: "Approval code expired" };
    }

    // Move temp file to final location
    try {
      if (existsSync(save.tempPath)) {
        const finalDir = dirname(save.finalPath);
        if (!existsSync(finalDir)) {
          mkdirSync(finalDir, { recursive: true });
        }
        renameSync(save.tempPath, save.finalPath);
      } else {
        return { ok: false, reason: "Temporary file not found" };
      }
      this.pending.delete(code);
      return { ok: true, finalPath: save.finalPath };
    } catch (err) {
      return { ok: false, reason: `Failed to save: ${err}` };
    }
  }

  /**
   * Clear all pending saves (e.g., after .reset-trust)
   */
  clearAll(): number {
    let count = 0;
    for (const save of this.pending.values()) {
      if (existsSync(save.tempPath)) {
        rmSync(save.tempPath);
      }
      count++;
    }
    this.pending.clear();
    return count;
  }

  /**
   * Get pending save info by code (for display)
   */
  get(code: string): PendingSessionSave | undefined {
    return this.pending.get(code);
  }

  /**
   * Get all pending saves
   */
  getAll(): PendingSessionSave[] {
    return Array.from(this.pending.values());
  }

  /**
   * Cleanup expired pending saves
   */
  cleanup(): void {
    const now = Date.now();
    for (const [code, save] of this.pending.entries()) {
      if (now > save.expiresAt) {
        if (existsSync(save.tempPath)) {
          rmSync(save.tempPath);
        }
        this.pending.delete(code);
      }
    }
  }
}
