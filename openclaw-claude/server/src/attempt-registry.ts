/**
 * Registry of persistent per-thread `Query` subprocesses.
 *
 * Background: the Claude Agent SDK's `Query.streamInput()` only calls
 * `transport.endInput()` (closing the underlying `claude` CLI's stdin, which
 * makes it exit) once the async-iterable it was given as `prompt` is
 * exhausted. Prior to this module, `runTurn()` closed that iterable
 * immediately after pushing the turn's one message, so every turn spawned
 * and killed its own subprocess. Anything a turn backgrounded (e.g. a shell
 * command started via `run_in_background`) died with it the moment the
 * turn's response finished, even though nothing had actually crashed.
 *
 * The fix: key a live `Query` + its still-open input queue by threadId, and
 * as long as the "attempt" (the SDK-options-defining settings: model,
 * thinking, tool policy, dynamic tools, permission mode — see
 * `computeAttemptFingerprint`) hasn't changed, feed subsequent turns into
 * the SAME queue instead of spawning a fresh subprocess. Only tear down and
 * respawn when the fingerprint changes (a genuine new attempt, e.g. a
 * fallback to a different model), the turn is interrupted, or the entry has
 * been idle long enough that holding the subprocess open is no longer worth
 * the resource cost.
 *
 * The SDK gives no per-turn correlation id in its message stream — messages
 * are demuxed by strict ordering instead (see `runTurn`'s pump/dispatch
 * split), which is sound because only one turn is ever in flight per thread.
 */

import type { ActiveTurn } from "./active-turns.js";
import type { ControllableUserInputQueue } from "./user-input.js";

/**
 * One entry per thread with a live, persistent `claude` subprocess.
 *
 * `liveTurnRef` is the seam that lets the SDK-facing closures built ONCE at
 * attempt-creation time (`canUseTool`, the dynamic-tools MCP bridge) stay
 * correct across every turn fed into this attempt afterward: those closures
 * read `liveTurnRef.turn` at call time rather than closing over a specific
 * turn, so `runTurn` only has to repoint `liveTurnRef.turn` before pushing
 * each new turn's input — no rebuilding of SDK options required (the SDK
 * only reads them once, at `query()` construction).
 */
export type AttemptEntry = {
  threadId: string;
  fingerprint: string;
  inputQueue: ControllableUserInputQueue;
  /** Passed as `sdkOptions.abortController` at creation; aborting kills the subprocess. */
  abortController: AbortController;
  liveTurnRef: { turn: ActiveTurn };
  /**
   * Set by `runTurn` while it awaits the current turn's result; the pump
   * loop calls it for every message until the turn's `result` message
   * arrives. Null when no turn is currently awaiting this attempt's stream.
   */
  currentHandler: ((msg: Record<string, unknown>) => void | Promise<void>) | null;
  /** Rejects the in-flight turn's wait if the pump loop itself ends (crash, abort, natural EOF). */
  currentReject: ((err: unknown) => void) | null;
  closed: boolean;
  createdAtMs: number;
  lastUsedAtMs: number;
};

export class AttemptRegistry {
  private readonly byThread = new Map<string, AttemptEntry>();

  get(threadId: string): AttemptEntry | undefined {
    return this.byThread.get(threadId);
  }

  set(threadId: string, entry: AttemptEntry): void {
    this.byThread.set(threadId, entry);
  }

  /** Remove `entry` only if it's still the current entry for its thread (avoids clobbering a newer one). */
  removeIfCurrent(entry: AttemptEntry): void {
    if (this.byThread.get(entry.threadId) === entry) {
      this.byThread.delete(entry.threadId);
    }
  }

  /** Tear down and remove any live entry for a thread — new attempt boundary, interrupt, or shutdown. */
  discard(threadId: string, reason: string): void {
    const entry = this.byThread.get(threadId);
    if (!entry) return;
    this.byThread.delete(threadId);
    closeEntry(entry, reason);
  }

  discardAll(reason: string): void {
    for (const threadId of [...this.byThread.keys()]) this.discard(threadId, reason);
  }

  /** Discard entries idle longer than `maxIdleMs`. Call periodically to bound subprocess growth. */
  sweepIdle(maxIdleMs: number): void {
    const now = Date.now();
    for (const [threadId, entry] of [...this.byThread.entries()]) {
      if (now - entry.lastUsedAtMs > maxIdleMs) this.discard(threadId, "attempt idle timeout");
    }
  }

  size(): number {
    return this.byThread.size;
  }
}

function closeEntry(entry: AttemptEntry, reason: string): void {
  if (entry.closed) return;
  entry.closed = true;
  entry.currentHandler = null;
  if (entry.currentReject) {
    const reject = entry.currentReject;
    entry.currentReject = null;
    reject(new Error(`attempt discarded: ${reason}`));
  }
  entry.inputQueue.close();
  if (!entry.abortController.signal.aborted) entry.abortController.abort(new Error(reason));
}

/**
 * Fingerprints the SDK options that are fixed for the lifetime of an
 * "attempt" (run.ts's run/attempt/turn hierarchy — model, thinking budget,
 * tool policy, permission mode, and dynamic tools don't change mid-attempt).
 * A change in any of these means the caller wants a genuinely new attempt,
 * not a continuation, so the bridge must spawn a fresh subprocess rather
 * than reuse the live one.
 */
export function computeAttemptFingerprint(input: {
  model: string;
  thinking: unknown;
  cwd: string | undefined;
  disallowedTools: string[];
  toolAliases: Record<string, string>;
  fastMode: boolean;
  allowAll: boolean;
  systemPromptAppend: string | undefined;
  mcpServersConfig: Record<string, unknown> | undefined;
  dynamicTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}): string {
  return JSON.stringify({
    model: input.model,
    thinking: input.thinking ?? null,
    cwd: input.cwd ?? null,
    disallowedTools: [...input.disallowedTools].sort(),
    toolAliases: sortedEntries(input.toolAliases),
    fastMode: input.fastMode,
    allowAll: input.allowAll,
    systemPromptAppend: input.systemPromptAppend ?? null,
    mcpServersConfig: input.mcpServersConfig ?? null,
    dynamicTools: [...input.dynamicTools]
      .map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

function sortedEntries(obj: Record<string, string>): Array<[string, string]> {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}
