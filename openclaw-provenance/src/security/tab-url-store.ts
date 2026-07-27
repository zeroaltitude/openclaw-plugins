/**
 * Persistent browser tab → URL store.
 *
 * Browser tools identify a tab via `targetId`, but the *value* placed in
 * that field is often a friendly alias — a `tabId` handle like "t1", or a
 * user-assigned `label` — rather than the raw CDP target id (see
 * extensions/browser/src/browser-tool.schema.ts: "Prefer suggestedTargetId,
 * tabId, or label from tabs output"). Tool results (browser.tabs,
 * browser.open) carry both the alias and the raw target id side by side;
 * this store records that link so a later call using only the alias can
 * still resolve to a URL for trust classification.
 *
 * Two tables, not one:
 *   - aliasToTarget: friendly handle (tabId/suggestedTargetId/label) → raw targetId
 *   - targetToUrl:   raw targetId → current URL
 *
 * Splitting them this way means browser.navigate — whose result carries the
 * raw targetId and the *new* URL but never an alias — only has to update
 * targetToUrl. Any alias recorded earlier (at browser.open/tabs time) still
 * points at the same raw targetId, so it automatically resolves to the
 * post-navigation URL without browser.navigate needing to know about
 * aliases at all.
 *
 * Persisted to disk so aliases survive gateway restarts. Persistence
 * introduces a staleness risk: alias numbering (t1, t2, ...) is assigned by
 * the browser host's in-memory runtime state and could in principle be
 * reassigned to a different tab after a restart before this plugin
 * observes a fresh browser.tabs/open call. Entries older than maxAgeMs are
 * therefore treated as unresolvable (fail closed — falls back to the
 * tool's default output taint — rather than trusting a possibly-stale
 * alias→URL link).
 *
 * File location: <workspaceDir>/.provenance/tab-urls.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Minimal shape of a browser tab reference as returned by browser.tabs/open. */
export interface TabLike {
  targetId?: string;
  tabId?: string;
  suggestedTargetId?: string;
  label?: string;
  url?: string;
}

interface AliasEntry {
  targetId: string;
  updatedAt: string; // ISO-8601
}

interface UrlEntry {
  url: string;
  updatedAt: string; // ISO-8601
}

export interface TabUrlFile {
  version: 1;
  aliasToTarget: Record<string, AliasEntry>;
  targetToUrl: Record<string, UrlEntry>;
}

/** Default staleness cutoff for resolution. See file header for rationale. */
export const DEFAULT_TAB_URL_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

const GLOBAL_STORE_KEY = Symbol.for("openclaw.provenance.tabUrlStore");
type GlobalStoreRegistry = Map<string, TabUrlStore>;
function getGlobalStoreRegistry(): GlobalStoreRegistry {
  const g = globalThis as unknown as Record<symbol, GlobalStoreRegistry>;
  if (!g[GLOBAL_STORE_KEY]) {
    g[GLOBAL_STORE_KEY] = new Map();
  }
  return g[GLOBAL_STORE_KEY];
}

/**
 * Returns the shared TabUrlStore instance for a given workspace, mirroring
 * WatermarkStore's singleton-per-workspace registry so every agent sharing
 * the workspace sees (and safely flushes) the same on-disk state.
 */
export function getSharedTabUrlStore(workspaceDir: string): TabUrlStore {
  const registry = getGlobalStoreRegistry();
  const existing = registry.get(workspaceDir);
  if (existing) return existing;
  const store = new TabUrlStore(workspaceDir);
  registry.set(workspaceDir, store);
  return store;
}

export class TabUrlStore {
  private filePath: string | undefined;
  private data: TabUrlFile;
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxAgeMs: number;

  /**
   * @param workspaceDir  When provided, state loads from and persists to
   *   `<workspaceDir>/.provenance/tab-urls.json`. When omitted, the store
   *   is purely in-memory (used as the default before a workspace has been
   *   configured, and by tests that don't care about persistence).
   */
  constructor(workspaceDir?: string, opts?: { maxAgeMs?: number }) {
    this.maxAgeMs = opts?.maxAgeMs ?? DEFAULT_TAB_URL_MAX_AGE_MS;
    if (workspaceDir) {
      const dir = join(workspaceDir, ".provenance");
      this.filePath = join(dir, "tab-urls.json");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.data = this.load();
  }

  private load(): TabUrlFile {
    if (this.filePath) {
      try {
        if (existsSync(this.filePath)) {
          const raw = readFileSync(this.filePath, "utf-8");
          const parsed = JSON.parse(raw) as TabUrlFile;
          if (parsed.version === 1 && parsed.aliasToTarget && parsed.targetToUrl) {
            return parsed;
          }
        }
      } catch {
        // Corrupt file — start fresh
      }
    }
    return { version: 1, aliasToTarget: {}, targetToUrl: {} };
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.filePath) return; // in-memory mode — nothing to flush
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.flush();
        this.writeTimer = null;
      }, 1000);
    }
  }

  /** Flush pending writes to disk immediately. No-op in in-memory mode. */
  flush(): void {
    if (!this.dirty || !this.filePath) return;
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

  private isFresh(updatedAt: string): boolean {
    return Date.now() - Date.parse(updatedAt) <= this.maxAgeMs;
  }

  /** Record tab identity/URL links observed from a browser.tabs/open/navigate result. */
  recordTabs(tabs: TabLike[]): void {
    const now = new Date().toISOString();
    let changed = false;
    for (const tab of tabs) {
      if (!tab.url) continue;
      const aliases = [tab.tabId, tab.suggestedTargetId, tab.label].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (tab.targetId) {
        this.data.targetToUrl[tab.targetId] = { url: tab.url, updatedAt: now };
        for (const alias of aliases) {
          this.data.aliasToTarget[alias] = { targetId: tab.targetId, updatedAt: now };
        }
        changed = true;
      } else {
        // No canonical raw targetId available (shouldn't happen for real
        // browser.tabs/open/navigate responses) — degrade by keying
        // directly on whatever alias we do have.
        for (const alias of aliases) {
          this.data.targetToUrl[alias] = { url: tab.url, updatedAt: now };
          changed = true;
        }
      }
    }
    if (changed) this.scheduleSave();
  }

  /** Resolve a targetId or alias (tabId/suggestedTargetId/label) to its current URL. */
  resolveTabUrl(id: string): string | undefined {
    const direct = this.data.targetToUrl[id];
    if (direct && this.isFresh(direct.updatedAt)) return direct.url;

    const alias = this.data.aliasToTarget[id];
    if (alias && this.isFresh(alias.updatedAt)) {
      const target = this.data.targetToUrl[alias.targetId];
      if (target && this.isFresh(target.updatedAt)) return target.url;
    }
    return undefined;
  }

  /** Remove entries not updated within maxAgeMs. Returns the number pruned. */
  pruneOlderThan(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [key, entry] of Object.entries(this.data.targetToUrl)) {
      if (Date.parse(entry.updatedAt) < cutoff) {
        delete this.data.targetToUrl[key];
        pruned++;
      }
    }
    for (const [key, entry] of Object.entries(this.data.aliasToTarget)) {
      if (Date.parse(entry.updatedAt) < cutoff) {
        delete this.data.aliasToTarget[key];
        pruned++;
      }
    }
    if (pruned > 0) this.scheduleSave();
    return pruned;
  }
}
