/**
 * Sliding context window for saliency scoring.
 * Ported from Cortex reflection system.
 *
 * Maintains a bounded window of recent messages so the saliency scorer
 * has conversational context, not just isolated messages. The window
 * is per-session to avoid cross-contamination.
 */

export interface WindowEntry {
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  agentId?: string;
  sessionKey?: string;
}

/** In-memory window store, keyed by sessionKey. */
const windows = new Map<string, WindowEntry[]>();

/** Last access time per session, for TTL-based cleanup. */
const lastAccess = new Map<string, number>();

const DEFAULT_WINDOW_SIZE = 10;
const MAX_ENTRY_CHARS = 500;

/** Max idle time before a session window is evicted (1 hour). */
const TTL_MS = 60 * 60 * 1000;

/**
 * Add a message to the session's sliding window.
 */
export function addToWindow(
  sessionKey: string,
  entry: Omit<WindowEntry, "timestamp">,
  maxSize = DEFAULT_WINDOW_SIZE,
): void {
  const key = sessionKey || "__default__";
  const window = windows.get(key) ?? [];

  window.push({
    ...entry,
    content: entry.content.slice(0, MAX_ENTRY_CHARS),
    timestamp: new Date().toISOString(),
  });

  // Trim to max size
  if (window.length > maxSize) {
    windows.set(key, window.slice(-maxSize));
  } else {
    windows.set(key, window);
  }

  lastAccess.set(key, Date.now());

  // Opportunistic TTL sweep: on every write, evict stale sessions.
  // Lightweight — just iterates the map and deletes old entries.
  sweepStale();
}

/**
 * Get recent context strings for the scorer prompt.
 * Returns the last N messages formatted as "[role]: content".
 */
export function getRecentContext(sessionKey: string, count = 5): string[] {
  const key = sessionKey || "__default__";
  const window = windows.get(key) ?? [];
  return window.slice(-count).map((e) => `[${e.role}]: ${e.content}`);
}

/**
 * Get the last user message from the window (for outbound scoring).
 */
export function getLastUserMessage(sessionKey: string): string | null {
  const key = sessionKey || "__default__";
  const window = windows.get(key) ?? [];
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].role === "user") return window[i].content;
  }
  return null;
}

/**
 * Clear a session's window (e.g., on session end).
 */
export function clearWindow(sessionKey: string): void {
  const key = sessionKey || "__default__";
  windows.delete(key);
  lastAccess.delete(key);
}

/**
 * Sweep stale sessions that haven't been accessed within TTL_MS.
 * Called opportunistically on every addToWindow call.
 */
function sweepStale(): void {
  const now = Date.now();
  for (const [key, ts] of lastAccess) {
    if (now - ts > TTL_MS) {
      windows.delete(key);
      lastAccess.delete(key);
    }
  }
}

/**
 * Get window size for a session (for debugging/monitoring).
 */
export function windowSize(sessionKey: string): number {
  return (windows.get(sessionKey || "__default__") ?? []).length;
}

/**
 * Get total number of active session windows (for monitoring).
 */
export function activeWindowCount(): number {
  return windows.size;
}
