/**
 * Persistent identity context store.
 *
 * Caches per-session identity data captured at inbound time so that
 * agent-loop hooks (before_prompt_build, llm_output, message_sending,
 * before_tool_call, after_tool_call) can read identity by sessionKey
 * instead of from the agent hookCtx.
 *
 * Why a plugin-side store: openclaw mainline does not populate identity
 * fields (senderId, senderIsOwner, groupId, spawnedBy, sourceProvider)
 * on the PluginHookAgentContext that's passed to agent-loop hooks.
 * Identity-bearing data lives on inbound_claim and subagent_spawned event
 * payloads. To stay portable across mainline updates without a fork-side
 * populator branch, we observe identity at inbound/spawn time, derive
 * what we need, and cache it here.
 *
 * Persistence: the store flushes to disk so identity survives gateway
 * restarts. Without persistence, a restart between inbound_claim and
 * a downstream agent hook would leave the cache empty and provenance
 * would silently fall back to "treat as untrusted/non-owner."
 *
 * File location: <workspaceDir>/.provenance/identity.json
 *
 * Singleton scope: one store per workspace path (matches WatermarkStore).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface IdentityRecord {
  sessionKey: string;
  /** Sender's platform-specific ID (e.g. Discord user ID, Slack U-id). */
  senderId?: string | null;
  /** Sender's display name (best-effort). */
  senderName?: string | null;
  /** Whether the sender is in the configured ownerNumbers list. */
  senderIsOwner: boolean;
  /** Original platform (slack/discord/telegram/whatsapp/...). Distinct from
   *  routing/messageProvider when those diverge. */
  sourceProvider?: string;
  /** Group/conversation id when the session is a group chat; null for DMs.
   *  We store the value (rather than just a boolean) so verbose logs can
   *  cite the actual id, but most policy checks just test truthiness. */
  groupId?: string | null;
  /** Parent session key for sub-agent sessions; null for top-level sessions. */
  spawnedBy?: string | null;
  /** ISO-8601 timestamp of the most recent update. */
  updatedAt: string;
}

export interface IdentityFile {
  version: 1;
  records: Record<string, IdentityRecord>;
}

// ── Channel-specific helpers ────────────────────────────────────────────

/**
 * Determine whether the session is a DM (no group) by inspecting the
 * sessionKey markers. Mainline canonicalizes session keys and tags DM
 * sessions with `:dm:` or `:direct:` markers across all current channels.
 *
 * Returns true if the sessionKey unambiguously identifies a DM. Returns
 * false otherwise (group/channel/thread or unparseable). The negative
 * case is the safe direction — assuming non-DM means owner-only
 * privileges are denied.
 */
export function sessionKeyIsDm(sessionKey: string): boolean {
  if (!sessionKey) return false;
  // Examples observed in the wild:
  //   agent:tank:discord:tank:direct:159471966640799744   (Discord DM)
  //   agent:main:slack:tabitha:dm:owner-123               (Slack DM)
  //   agent:main:discord:group:1234567890                 (Discord group)
  // Lowercase the key once; markers are stable.
  const lower = sessionKey.toLowerCase();
  return lower.includes(":dm:") || lower.includes(":direct:");
}

/**
 * Best-effort owner classification: senderId matches an entry in the
 * ownerNumbers config. If the configured list is empty, fall back to
 * `false` — provenance treats unknown senders as non-owners.
 */
export function computeSenderIsOwner(
  senderId: string | null | undefined,
  ownerNumbers: readonly string[],
): boolean {
  if (!senderId) return false;
  if (ownerNumbers.length === 0) return false;
  return ownerNumbers.includes(senderId);
}

/**
 * Derive groupId from the inbound_claim event payload.
 *
 * Mainline already computes the canonical groupId and stores it on
 * `event.metadata.groupId`. The `event.isGroup` boolean tells us whether
 * to surface it (DMs return null even if a routing-side groupId is set).
 * The sessionKey-marker fallback handles legacy events where metadata
 * may be absent.
 */
export function deriveGroupId(params: {
  sessionKey: string;
  isGroup?: boolean;
  metadataGroupId?: unknown;
  conversationId?: string | null;
  threadId?: string | number | null;
}): string | null {
  // Trust the explicit isGroup signal first.
  if (params.isGroup === false) return null;
  // If we know it's a group, prefer the canonical metadata value, then
  // conversationId, then threadId.
  if (params.isGroup === true) {
    if (typeof params.metadataGroupId === "string" && params.metadataGroupId.length > 0) {
      return params.metadataGroupId;
    }
    if (typeof params.conversationId === "string" && params.conversationId.length > 0) {
      return params.conversationId;
    }
    if (params.threadId !== undefined && params.threadId !== null) {
      return String(params.threadId);
    }
    return null;
  }
  // No explicit isGroup signal: fall back to sessionKey markers.
  if (sessionKeyIsDm(params.sessionKey)) return null;
  if (typeof params.metadataGroupId === "string" && params.metadataGroupId.length > 0) {
    return params.metadataGroupId;
  }
  if (typeof params.conversationId === "string" && params.conversationId.length > 0) {
    return params.conversationId;
  }
  if (params.threadId !== undefined && params.threadId !== null) {
    return String(params.threadId);
  }
  return null;
}

// ── Singleton registry ─────────────────────────────────────────────────

const GLOBAL_STORE_KEY = Symbol.for("openclaw.provenance.identityStore");
type GlobalStoreRegistry = Map<string, IdentityStore>;
function getGlobalStoreRegistry(): GlobalStoreRegistry {
  const g = globalThis as unknown as Record<symbol, GlobalStoreRegistry>;
  if (!g[GLOBAL_STORE_KEY]) {
    g[GLOBAL_STORE_KEY] = new Map();
  }
  return g[GLOBAL_STORE_KEY];
}

export function getSharedIdentityStore(workspaceDir: string): IdentityStore {
  const registry = getGlobalStoreRegistry();
  const existing = registry.get(workspaceDir);
  if (existing) return existing;
  const store = new IdentityStore(workspaceDir);
  registry.set(workspaceDir, store);
  return store;
}

// ── Store ──────────────────────────────────────────────────────────────

export class IdentityStore {
  private filePath: string;
  private data: IdentityFile;
  private dirty = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceDir: string) {
    const dir = join(workspaceDir, ".provenance");
    this.filePath = join(dir, "identity.json");

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.data = this.load();
  }

  private load(): IdentityFile {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as IdentityFile;
        if (parsed.version === 1 && parsed.records) {
          return parsed;
        }
      }
    } catch {
      // Corrupt file — start fresh
    }
    return { version: 1, records: {} };
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

  /** Get the identity record for a session, or undefined if none cached. */
  get(sessionKey: string): IdentityRecord | undefined {
    return this.data.records[sessionKey];
  }

  /** Convenience: return the senderIsOwner flag, defaulting to false. */
  isOwner(sessionKey: string): boolean {
    return this.data.records[sessionKey]?.senderIsOwner === true;
  }

  /** Convenience: is this session a non-spawned owner-DM? */
  isOwnerDm(sessionKey: string): boolean {
    const r = this.data.records[sessionKey];
    if (!r) return false;
    return r.senderIsOwner === true && !r.groupId && !r.spawnedBy;
  }

  /**
   * Upsert a record. Caller passes the full record; we add updatedAt and
   * persist. If a prior record exists, fields with `undefined` in the
   * patch are *kept* from the prior — this lets early hooks (inbound_claim)
   * set most fields and later hooks (subagent_spawned) extend with
   * spawnedBy without clobbering.
   */
  upsert(record: Partial<IdentityRecord> & { sessionKey: string }): void {
    const prior = this.data.records[record.sessionKey];
    const merged: IdentityRecord = {
      sessionKey: record.sessionKey,
      senderId: record.senderId !== undefined ? record.senderId : prior?.senderId,
      senderName: record.senderName !== undefined ? record.senderName : prior?.senderName,
      senderIsOwner:
        record.senderIsOwner !== undefined
          ? record.senderIsOwner
          : (prior?.senderIsOwner ?? false),
      sourceProvider:
        record.sourceProvider !== undefined ? record.sourceProvider : prior?.sourceProvider,
      groupId: record.groupId !== undefined ? record.groupId : prior?.groupId,
      spawnedBy: record.spawnedBy !== undefined ? record.spawnedBy : prior?.spawnedBy,
      updatedAt: new Date().toISOString(),
    };
    this.data.records[record.sessionKey] = merged;
    this.scheduleSave();
  }

  /**
   * Set just spawnedBy on an existing record (used by subagent_spawned).
   * Creates a stub record if none exists yet — the spawn event may
   * arrive before any inbound_claim from the child session.
   */
  setSpawnedBy(sessionKey: string, parentSessionKey: string): void {
    const prior = this.data.records[sessionKey];
    const merged: IdentityRecord = {
      sessionKey,
      senderId: prior?.senderId ?? null,
      senderName: prior?.senderName ?? null,
      senderIsOwner: prior?.senderIsOwner ?? false,
      sourceProvider: prior?.sourceProvider,
      groupId: prior?.groupId ?? null,
      spawnedBy: parentSessionKey,
      updatedAt: new Date().toISOString(),
    };
    this.data.records[sessionKey] = merged;
    this.scheduleSave();
  }

  /** Remove a record (e.g. on session_end). */
  remove(sessionKey: string): void {
    if (sessionKey in this.data.records) {
      delete this.data.records[sessionKey];
      this.scheduleSave();
    }
  }

  /** Total number of cached identity records — useful for diagnostics/tests. */
  size(): number {
    return Object.keys(this.data.records).length;
  }

  /** Diagnostic snapshot — for logs only, do not mutate. */
  snapshot(): Readonly<IdentityFile> {
    return this.data;
  }
}
