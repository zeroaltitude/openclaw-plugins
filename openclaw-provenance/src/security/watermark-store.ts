/**
 * Persistent taint watermark store.
 * 
 * Stores session-level taint watermarks to disk so they survive
 * gateway restarts. Each session's watermark tracks the worst taint
 * level seen and the root cause reason.
 * 
 * File location: <workspaceDir>/.provenance/watermarks.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TrustLevel, TRUST_ORDER, minTrust } from "./trust-levels.js";

export interface WatermarkEntry {
  level: TrustLevel;
  reason: string;
  escalatedAt: string;        // ISO-8601 timestamp
  escalatedBy: string;        // what caused the escalation (tool name, content scan, etc.)
  lastImpactedTool?: string;  // last tool that was denied/required authorization
  resetHistory: Array<{
    resetAt: string;          // ISO-8601 timestamp
    previousLevel: TrustLevel;
    previousReason: string;
  }>;
}

export interface WatermarkFile {
  version: 1;
  watermarks: Record<string, WatermarkEntry>;
}

export class WatermarkStore {
  private filePath: string;
  private data: WatermarkFile;
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceDir: string) {
    const dir = join(workspaceDir, ".provenance");
    this.filePath = join(dir, "watermarks.json");

    // Ensure directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Load existing data or initialize
    this.data = this.load();
  }

  private load(): WatermarkFile {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as WatermarkFile;
        if (parsed.version === 1 && parsed.watermarks) {
          return parsed;
        }
      }
    } catch {
      // Corrupt file — start fresh
    }
    return { version: 1, watermarks: {} };
  }

  private scheduleSave(): void {
    this.dirty = true;
    // Debounce writes — save at most once per second
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.flush();
        this.writeTimer = null;
      }, 1000);
    }
  }

  /** Flush pending writes to disk immediately */
  flush(): void {
    if (!this.dirty) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Best-effort — don't crash the plugin on write failure
    }
  }

  /** Get the watermark for a session */
  get(sessionKey: string): WatermarkEntry | undefined {
    return this.data.watermarks[sessionKey];
  }

  /** Get watermark in the format expected by the rest of the plugin */
  getLevel(sessionKey: string): { level: TrustLevel; reason: string } | undefined {
    const entry = this.data.watermarks[sessionKey];
    if (!entry) return undefined;
    return { level: entry.level, reason: entry.reason };
  }

  /**
   * Escalate the watermark for a session.
   * Only updates if the new taint is stricter than the existing one.
   * Returns true if the watermark was changed.
   */
  escalate(
    sessionKey: string,
    level: TrustLevel,
    reason: string,
    escalatedBy: string,
  ): boolean {
    const existing = this.data.watermarks[sessionKey];
    
    if (existing) {
      const merged = minTrust(existing.level, level);
      const existingIdx = TRUST_ORDER.indexOf(existing.level);
      const mergedIdx = TRUST_ORDER.indexOf(merged);
      
      // Only update if taint got worse
      if (mergedIdx <= existingIdx) return false;
      
      existing.level = merged;
      existing.reason = reason;
      existing.escalatedAt = new Date().toISOString();
      existing.escalatedBy = escalatedBy;
    } else {
      // Only create watermark if taint is worse than owner
      if (level === "owner" || level === "system") return false;
      
      this.data.watermarks[sessionKey] = {
        level,
        reason,
        escalatedAt: new Date().toISOString(),
        escalatedBy,
        resetHistory: [],
      };
    }
    
    this.scheduleSave();
    return true;
  }

  /** Update the last impacted tool for a session */
  setLastImpactedTool(sessionKey: string, toolName: string): void {
    const entry = this.data.watermarks[sessionKey];
    if (entry) {
      entry.lastImpactedTool = toolName;
      this.scheduleSave();
    }
  }

  /** Clear the watermark for a session (used by .reset-trust) */
  clear(sessionKey: string): void {
    const entry = this.data.watermarks[sessionKey];
    if (entry) {
      // Record reset in history before clearing
      entry.resetHistory.push({
        resetAt: new Date().toISOString(),
        previousLevel: entry.level,
        previousReason: entry.reason,
      });
      // Remove the watermark
      delete this.data.watermarks[sessionKey];
      this.scheduleSave();
    }
  }

  /** Clear the watermark and keep audit trail (returns the cleared entry for logging) */
  clearWithAudit(sessionKey: string): WatermarkEntry | undefined {
    const entry = this.data.watermarks[sessionKey];
    if (!entry) return undefined;
    
    const snapshot = { ...entry, resetHistory: [...entry.resetHistory] };
    this.clear(sessionKey);
    return snapshot;
  }

  /** List all active watermarks (for diagnostics) */
  listAll(): Record<string, WatermarkEntry> {
    return { ...this.data.watermarks };
  }

  /** Clean up stale sessions (call periodically) */
  cleanup(activeSessions: Set<string>): number {
    let removed = 0;
    for (const key of Object.keys(this.data.watermarks)) {
      if (!activeSessions.has(key)) {
        delete this.data.watermarks[key];
        removed++;
      }
    }
    if (removed > 0) this.scheduleSave();
    return removed;
  }
}
