/**
 * Persistent taint watermark store.
 *
 * Stores session-level taint watermarks to disk so they survive
 * gateway restarts. Each session's watermark tracks the worst taint
 * level seen and the root cause reason.
 *
 * File location: <workspaceDir>/.provenance/watermarks.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type TrustLevel, TRUST_ORDER, minTrust } from "./trust-levels.js";

/** Decomposed trust record for a single URI source */
export interface UriTaintRecord {
  uri: string;
  toolTrust: TrustLevel;
  uriTrust?: TrustLevel;
  effectiveTrust: TrustLevel;
  tool: string;
  firstSeenAt: string;
  turnId: string;
}

export interface WatermarkEntry {
  level: TrustLevel;
  reason: string;
  /** URI-level taint records — audit trail for what caused taint */
  uriTaintRecords?: UriTaintRecord[];
  escalatedAt: string; // ISO-8601 timestamp
  escalatedBy: string; // what caused the escalation
  lastImpactedTool?: string;
  resetHistory: Array<{
    resetAt: string;
    previousLevel: TrustLevel;
    previousReason: string;
  }>;
}

export interface WatermarkFile {
  version: 1;
  watermarks: Record<string, WatermarkEntry>;
}

/**
 * Shared singleton registry keyed by workspace path.
 *
 * The provenance plugin is initialised once per agent, which means multiple
 * `WatermarkStore` instances would otherwise point at the same file with
 * independent in-memory state. That races: one instance clears its map on
 * /reset-trust, but another instance (unaware of the clear) still holds the
 * old entry and overwrites the disk file on its next flush.
 *
 * Scoping the singleton to workspace path ensures every agent running in
 * the same gateway shares one store per workspace.
 */
const GLOBAL_STORE_KEY = Symbol.for("openclaw.provenance.watermarkStore");
type GlobalStoreRegistry = Map<string, WatermarkStore>;
function getGlobalStoreRegistry(): GlobalStoreRegistry {
  const g = globalThis as unknown as Record<symbol, GlobalStoreRegistry>;
  if (!g[GLOBAL_STORE_KEY]) {
    g[GLOBAL_STORE_KEY] = new Map();
  }
  return g[GLOBAL_STORE_KEY];
}

/**
 * Returns the shared WatermarkStore instance for a given workspace.
 * Every agent sharing the same workspace sees the same store.
 */
export function getSharedWatermarkStore(workspaceDir: string): WatermarkStore {
  const registry = getGlobalStoreRegistry();
  const existing = registry.get(workspaceDir);
  if (existing) return existing;
  const store = new WatermarkStore(workspaceDir);
  registry.set(workspaceDir, store);
  return store;
}

export class WatermarkStore {
  private filePath: string;
  private data: WatermarkFile;
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceDir: string) {
    const dir = join(workspaceDir, ".provenance");
    this.filePath = join(dir, "watermarks.json");

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

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
      writeFileSync(
        this.filePath,
        JSON.stringify(this.data, null, 2),
        "utf-8",
      );
      this.dirty = false;
    } catch {
      // Best-effort — don't crash the plugin on write failure
    }
  }

  /** Get the watermark for a session */
  get(sessionKey: string): WatermarkEntry | undefined {
    return this.data.watermarks[sessionKey];
  }

  /** Get watermark level and reason */
  getLevel(
    sessionKey: string,
  ): { level: TrustLevel; reason: string } | undefined {
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
    uriTaintRecords?: UriTaintRecord[],
  ): boolean {
    const existing = this.data.watermarks[sessionKey];

    if (existing) {
      const merged = minTrust(existing.level, level);
      const existingIdx = TRUST_ORDER.indexOf(existing.level);
      const mergedIdx = TRUST_ORDER.indexOf(merged);

      if (mergedIdx <= existingIdx) {
        // Even if level didn't escalate, append new URI records
        if (uriTaintRecords?.length) {
          existing.uriTaintRecords = [
            ...(existing.uriTaintRecords ?? []),
            ...uriTaintRecords,
          ];
        }
        this.scheduleSave();
        return false;
      }

      existing.level = merged;
      existing.reason = reason;
      existing.escalatedAt = new Date().toISOString();
      existing.escalatedBy = escalatedBy;
      if (uriTaintRecords?.length) {
        existing.uriTaintRecords = [
          ...(existing.uriTaintRecords ?? []),
          ...uriTaintRecords,
        ];
      }
    } else {
      // Only create watermark if taint is worse than trusted
      if (level === "trusted") return false;

      this.data.watermarks[sessionKey] = {
        level,
        reason,
        uriTaintRecords: uriTaintRecords?.length ? uriTaintRecords : undefined,
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

  /** Clear the watermark for a session */
  clear(sessionKey: string): void {
    const entry = this.data.watermarks[sessionKey];
    if (entry) {
      entry.resetHistory.push({
        resetAt: new Date().toISOString(),
        previousLevel: entry.level,
        previousReason: entry.reason,
      });
      delete this.data.watermarks[sessionKey];
      this.scheduleSave();
    }
  }

  /** Clear the watermark and return the cleared entry for logging */
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

  /** Clean up stale sessions */
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

  /**
   * Remove watermark entries older than the given age (in milliseconds).
   * Returns the number of entries pruned.
   */
  pruneOlderThan(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    let pruned = 0;
    for (const [key, entry] of Object.entries(this.data.watermarks)) {
      if (entry.escalatedAt < cutoff) {
        delete this.data.watermarks[key];
        pruned++;
      }
    }
    if (pruned > 0) this.scheduleSave();
    return pruned;
  }
}
