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
import type { Logger } from "./transport.js";
import type { ControllableUserInputQueue } from "./user-input.js";

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The single SDK `Query` capability this module needs: replacing the dynamic
 * MCP server set on an already-running session. Added to the SDK in 0.3.x —
 * before it existed, a tool-catalog change could only be honoured by starting
 * a new session, which is what made catalog drift so expensive.
 */
export type LiveQueryToolSurface = {
  setMcpServers(
    servers: Record<string, unknown>,
  ): Promise<{ added?: string[]; removed?: string[]; errors?: unknown }>;
};

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
  /** The raw, unhashed input `fingerprint` was computed from — kept so a later mismatch can be diffed field-by-field for diagnostics (see `diffAttemptFingerprintInputs`). */
  fingerprintInput: AttemptFingerprintInput;
  inputQueue: ControllableUserInputQueue;
  /** Passed as `sdkOptions.abortController` at creation; aborting kills the subprocess. */
  abortController: AbortController;
  liveTurnRef: { turn: ActiveTurn };
  /**
   * The live `Query` returned by the SDK's `query()`, narrowed to just the
   * capability we need from it. Retained so the dynamic tool surface can be
   * swapped on the RUNNING session (`setMcpServers`) instead of rotating the
   * thread — see `refreshDynamicTools`. Typed structurally rather than as the
   * SDK's `Query` so this module stays free of the SDK's type surface.
   */
  query: LiveQueryToolSurface;
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
  private readonly logger: Logger;

  constructor(logger: Logger = NOOP_LOGGER) {
    this.logger = logger;
  }

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

  /**
   * Tear down and remove any live entry for a thread — new attempt boundary,
   * interrupt, idle sweep, or shutdown. `details` is optional structured
   * context (e.g. which fingerprint fields changed) logged alongside the
   * reason — this discard path is otherwise the only place a subprocess
   * (and anything it backgrounded, like a `run_in_background` shell job)
   * gets torn down, so it's worth making visible rather than silent.
   */
  discard(threadId: string, reason: string, details?: Record<string, unknown>): void {
    const entry = this.byThread.get(threadId);
    if (!entry) return;
    this.byThread.delete(threadId);
    this.logger.info("[attempt-registry] discarding attempt", { threadId, reason, ...details });
    closeEntry(entry, reason, this.logger);
  }

  discardAll(reason: string): void {
    for (const threadId of [...this.byThread.keys()]) this.discard(threadId, reason);
  }

  /**
   * Discard entries idle longer than `maxIdleMs`. Call periodically to bound
   * subprocess growth.
   *
   * `lastUsedAtMs` is only refreshed when a turn STARTS (attempt creation, or
   * a reused attempt's next turn) — it is never touched again while that turn
   * runs. Entries with a turn currently in flight (`currentHandler !== null`,
   * set for the whole span `waitForTurnResult` is awaiting the turn's result
   * message) are therefore skipped regardless of elapsed time: without this
   * guard, any turn running longer than `maxIdleMs` — not an idle attempt,
   * one that's actively executing — gets its subprocess yanked out from under
   * it, surfacing as "attempt discarded: attempt idle timeout" and failing
   * the turn outright. "Idle" means no turn has used this attempt for
   * `maxIdleMs`, not "the current turn has taken a while."
   */
  sweepIdle(maxIdleMs: number): void {
    const now = Date.now();
    for (const [threadId, entry] of [...this.byThread.entries()]) {
      if (entry.currentHandler !== null) continue; // turn in flight — not idle, no matter how long it's running
      if (now - entry.lastUsedAtMs > maxIdleMs) this.discard(threadId, "attempt idle timeout");
    }
  }

  /**
   * Swap the dynamic MCP server set on a LIVE attempt instead of rotating the
   * thread.
   *
   * This is the cheap path for a tool-catalog change. Rotation costs a full
   * transcript copy, a new SDK session id (so a cold prompt cache) and a
   * respawned subprocess that strands whatever the previous turn backgrounded.
   * `setMcpServers` re-registers the surface on the running session, so none
   * of that is paid and the catalog is still genuinely correct — which matters,
   * because catalog changes are often POLICY (e.g. the owner-only control-plane
   * deny), and quietly keeping the old surface would be a policy bypass.
   *
   * Returns null when there is no live attempt to refresh, so the caller can
   * fall back to rotation. Never throws for the not-found case; a failure from
   * the SDK itself does propagate, because silently "succeeding" would leave
   * the model holding a surface we told the caller we had replaced.
   */
  async refreshDynamicTools(
    threadId: string,
    params: {
      servers: Record<string, unknown>;
      dynamicTools: AttemptFingerprintInput["dynamicTools"];
    },
  ): Promise<{ added: string[]; removed: string[] } | null> {
    const entry = this.byThread.get(threadId);
    if (!entry || entry.closed) return null;
    const result = await entry.query.setMcpServers(params.servers);
    // MUST re-fingerprint, and this is the subtle half of the fix. dynamicTools
    // is part of AttemptFingerprintInput, so if the entry kept its old
    // fingerprint the very next turn would compute a mismatch and discard the
    // attempt — respawning the subprocess we just went out of our way not to
    // respawn, and undoing the entire benefit.
    entry.fingerprintInput = { ...entry.fingerprintInput, dynamicTools: params.dynamicTools };
    entry.fingerprint = computeAttemptFingerprint(entry.fingerprintInput);
    const added = result.added ?? [];
    const removed = result.removed ?? [];
    this.logger.info("[attempt-registry] refreshed dynamic tools on a live attempt", {
      threadId,
      toolCount: params.dynamicTools.length,
      added,
      removed,
    });
    return { added, removed };
  }

  size(): number {
    return this.byThread.size;
  }
}

function closeEntry(entry: AttemptEntry, reason: string, logger: Logger): void {
  if (entry.closed) return;
  entry.closed = true;
  entry.currentHandler = null;
  if (entry.currentReject) {
    const reject = entry.currentReject;
    entry.currentReject = null;
    reject(new Error(`attempt discarded: ${reason}`));
  } else {
    // No turn was actively awaiting this attempt's result. There's no promise
    // to reject, so this WARN is the only signal that the teardown happened.
    //
    // Deliberately says "any ... IS TORN DOWN WITH IT" rather than the older
    // "was silently killed": this branch cannot tell whether anything was
    // actually running. It is also the NORMAL end of every one-shot turn
    // (heartbeat/cron), where nothing was backgrounded and nothing is lost.
    // Asserting a kill on every such teardown made the loudest line in the
    // log the least informative one, which trains readers to ignore it — and
    // it is the line that matters when work really is lost.
    //
    // Narrowing this to fire only when the subprocess genuinely had live
    // children would be better still, but is not available here: the
    // backgrounded shells are children of the `claude` subprocess, not of
    // this bridge process, so this call site has no handle on their liveness.
    logger.warn(
      "[attempt-registry] discarded an attempt with no turn awaiting its result — any work still running under this subprocess (e.g. a backgrounded shell command) is torn down with it",
      { threadId: entry.threadId, reason },
    );
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
export type AttemptFingerprintInput = {
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
};

function normalizeAttemptFingerprintInput(input: AttemptFingerprintInput) {
  return {
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
  };
}

export function computeAttemptFingerprint(input: AttemptFingerprintInput): string {
  return JSON.stringify(normalizeAttemptFingerprintInput(input));
}

/**
 * Field-level diff between two fingerprint inputs, for diagnostic logging
 * when a mismatch forces a new attempt (see the `discard(..., "attempt
 * fingerprint changed")` call site in turn-runner.ts). `computeAttemptFingerprint`
 * only exposes an opaque hash, which is enough to detect *that* something
 * changed but not *what* — this walks the same normalized shape field-by-field
 * so the discard log line can say e.g. `dynamicTools (73 -> 0 tools)` instead
 * of leaving the cause to be inferred after the fact.
 */
export function diffAttemptFingerprintInputs(
  prev: AttemptFingerprintInput,
  next: AttemptFingerprintInput,
): string[] {
  const a = normalizeAttemptFingerprintInput(prev);
  const b = normalizeAttemptFingerprintInput(next);
  const changes: string[] = [];
  for (const key of Object.keys(a) as Array<keyof typeof a>) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changes.push(
        key === "dynamicTools"
          ? `dynamicTools (${prev.dynamicTools.length} -> ${next.dynamicTools.length} tools)`
          : key,
      );
    }
  }
  return changes;
}

function sortedEntries(obj: Record<string, string>): Array<[string, string]> {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}
