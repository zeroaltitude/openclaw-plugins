/**
 * Continuous, hook-driven graph ingestion.
 *
 * Registers OpenClaw's real plugin hooks (`before_agent_run` / `agent_end`,
 * see `src/plugins/hook-types.ts` in the openclaw core repo) so the graph
 * stays current between full reingests, instead of only updating on a
 * timepoint/on-demand basis. `agent_end`'s `messages` array uses the same
 * `{role, content, timestamp, ...}` message shape as the persisted JSONL
 * transcript entries `ingest.ts` reads from disk, so both paths share the
 * exact same per-message conversion (`ingestMessage` in message-ingest.ts)
 * and therefore compute identical node/edge ids for the same message.
 *
 * `liveSessionIds` backs the `session.live` field the UI already renders
 * (pulsing dot, tooltip) but that nothing server-side previously populated.
 * It's a plain in-memory Set, not a DB column: liveness is inherently
 * ephemeral process state (true only while a turn is actually in flight),
 * so there is nothing meaningful to persist or recover across a restart.
 */

import type Database from "better-sqlite3";
import { upsertNode } from "./db.js";
import { ingestMessage, shortHash, type MessageIngestState, type RawMessageLike } from "./message-ingest.js";

/** Session ids with a turn currently in flight. */
export const liveSessionIds = new Set<string>();

const DEFAULT_MAX_CONTENT_CHARS = 2000;

/** Per-session cursor into the `agent_end` `messages` array, so a turn only ingests
 * whatever is new since the last turn instead of re-walking the whole (bounded, but
 * still up to ~100-message) history window every time. Same pattern already proven
 * in production by extensions/memory-lancedb's auto-capture (openclaw core repo) —
 * fingerprint-matched rather than a fixed trailing-N slice, so it stays correct even
 * if the history window's size or composition shifts between turns. Purely an
 * in-memory perf/dedup aid: upsertNode/insertEdge are idempotent, so losing this
 * cursor (plugin reload, restart) just means the next turn reprocesses more of its
 * own history — harmless, not a correctness bug. */
interface AgentEndCursor {
  nextIndex: number;
  lastMessageFingerprint?: string;
}
const agentEndCursors = new Map<string, AgentEndCursor>();

function messageFingerprint(message: unknown): string {
  const msg = message as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object") return `${typeof message}:${String(message)}`;
  try {
    return JSON.stringify({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
  } catch {
    return `${String(msg.role)}:${String(msg.content)}`;
  }
}

function resolveStartIndex(messages: unknown[], cursor: AgentEndCursor | undefined): number {
  if (!cursor) return 0;
  if (cursor.lastMessageFingerprint) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messageFingerprint(messages[index]) === cursor.lastMessageFingerprint) return index + 1;
    }
    return 0;
  }
  return cursor.nextIndex <= messages.length ? cursor.nextIndex : 0;
}

interface AgentHookContext {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
}

interface AgentEndEvent {
  success?: boolean;
  messages?: unknown[];
}

function isRawMessageLike(value: unknown): value is RawMessageLike {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).role === "string";
}

/** Registers the live-ingest hooks against an already-open graph DB. */
export function registerLiveIngestHooks(
  db: Database.Database,
  api: {
    on?: (
      hookName: string,
      handler: (event: unknown, ctx: unknown) => unknown,
      opts?: { priority?: number; timeoutMs?: number },
    ) => void;
  },
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void },
): void {
  if (typeof api.on !== "function") {
    log.warn("[graph-context] live-ingest: api.on not available on plugin API, skipping");
    return;
  }

  api.on("before_agent_run", (_event: unknown, ctx: unknown) => {
    const sessionId = (ctx as AgentHookContext | undefined)?.sessionId;
    if (sessionId) liveSessionIds.add(sessionId);
    return undefined;
  });

  api.on("agent_end", (event: unknown, ctx: unknown) => {
    const hookCtx = ctx as AgentHookContext | undefined;
    const { agentId, sessionId, sessionKey } = hookCtx ?? {};
    if (sessionId) liveSessionIds.delete(sessionId);
    if (!agentId || !sessionId) return undefined;

    try {
      ingestAgentEndMessages(db, agentId, sessionId, sessionKey, event as AgentEndEvent | undefined);
    } catch (err) {
      log.warn(`[graph-context] live-ingest: agent_end handling failed for session ${sessionId}:`, err);
    }
    return undefined;
  });

  log.info("[graph-context] live-ingest hooks registered (before_agent_run, agent_end)");
}

function ingestAgentEndMessages(
  db: Database.Database,
  agentId: string,
  sessionId: string,
  sessionKey: string | undefined,
  event: AgentEndEvent | undefined,
): void {
  const messages = event?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  const cursorKey = sessionKey ?? sessionId;
  const startIndex = resolveStartIndex(messages, agentEndCursors.get(cursorKey));
  if (startIndex >= messages.length) return;

  const resolvedSessionKey = sessionKey ?? `agent:${agentId}:unknown:${sessionId}`;
  const sessionNodeId = `session:${sessionId}`;
  const now = Date.now();

  const existingSession = db.prepare("SELECT id FROM nodes WHERE id = ? AND type = 'session'").get(sessionNodeId);
  if (!existingSession) {
    // Brand new session the file-based ingest has never seen — create its session node now
    // so later messages have a sequence-chain root. A later full reingest will fill in the
    // real cwd/session-type/etc. properties from the JSONL header; this is just a placeholder.
    upsertNode(db, {
      id: sessionNodeId,
      type: "session",
      agent_id: agentId,
      session_id: sessionId,
      session_key: resolvedSessionKey,
      ts: now,
    });
  }

  const lastNode = db
    .prepare("SELECT id FROM nodes WHERE session_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(sessionId) as { id: string } | undefined;

  const state: MessageIngestState = {
    agentId,
    sessionId,
    sessionKey: resolvedSessionKey,
    sessionNodeId,
    prevNodeId: lastNode?.id ?? null,
    toolCallNodeById: new Map(),
    maxContentChars: DEFAULT_MAX_CONTENT_CHARS,
  };

  let lastIndexProcessed = startIndex - 1;
  for (let i = startIndex; i < messages.length; i++) {
    const raw = messages[i];
    if (!isRawMessageLike(raw)) continue;
    const msgTs = typeof raw.timestamp === "number" ? raw.timestamp : now;
    // No entry.id is available from the hook payload (only the persisted JSONL entries have
    // one) — hash on position + timestamp instead. Stable across repeated firings of the same
    // event (idempotent retries); a full reset+reingest later wipes and rebuilds everything
    // from the JSONL's own entry ids anyway, so this id never needs to match that one.
    const entryId = shortHash("live", sessionId, String(i), String(msgTs));
    const r = ingestMessage(db, raw, entryId, msgTs, state);
    state.prevNodeId = r.prevNodeId;
    lastIndexProcessed = i;
  }

  if (lastIndexProcessed >= startIndex) {
    agentEndCursors.set(cursorKey, {
      nextIndex: lastIndexProcessed + 1,
      lastMessageFingerprint: messageFingerprint(messages[lastIndexProcessed]),
    });
  }
}
