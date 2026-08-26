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
 * The bridge-owned in-process MCP server backing `mcp__<serverName>__*`, as
 * this module needs to see it. Structurally typed (rather than importing
 * `DynamicToolsHandle`) for the same reason `LiveQueryToolSurface` is: it keeps
 * this module free of the MCP/Anthropic SDK type surface.
 */
export type LiveDynamicToolSurface = {
  /** The MCP server name — the `openclaw` in `mcp__openclaw__*`. */
  serverName: string;
  /** The live `McpServer`. MUST be handed back to `setMcpServers` on every refresh. */
  instance: unknown;
  /** Swap the advertised + callable tool set on the running server. */
  setTools(specs: AttemptFingerprintInput["dynamicTools"]): void;
  /** The currently advertised spec set. */
  getTools(): AttemptFingerprintInput["dynamicTools"];
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
   * The bridge-owned dynamic-tools MCP server for this attempt, if the thread
   * carried any dynamic tools when the attempt was created. Retained because
   * `refreshDynamicTools` cannot work without it on two counts: it needs
   * `setTools` to actually change the surface, and it needs `instance` to hand
   * back to `setMcpServers` so the SDK's desired-state diff does not tear the
   * transport down. Undefined when the attempt was created with no dynamic
   * tools — in which case there is no server to refresh and the caller must
   * rotate instead.
   */
  dynamicTools?: LiveDynamicToolSurface;
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
   *
   * ── Why this is more than one `setMcpServers` call (openclaw-d42b) ─────────
   *
   * `Query.setMcpServers` treats the PRESENCE OF `instance` as the desired-state
   * signal for sdk-type servers:
   *
   *   for (const [name, cfg] of Object.entries(arg))
   *     if (cfg.type === "sdk" && "instance" in cfg) desired[name] = cfg.instance;
   *     else passthrough[name] = cfg;
   *   for (const name of connected) if (!(name in desired)) await disconnectSdkMcpServer(name);
   *   for (const [name, inst] of Object.entries(desired)) if (!connected.has(name)) connect(name, inst);
   *   await request({ subtype: "mcp_set_servers", servers: { ...passthrough, ...shapesOf(desired) } });
   *
   * Two consequences drive the shape of this method:
   *
   * 1. A SHAPE-ONLY `{ type: "sdk", name }` entry (no `instance`) lands in
   *    `passthrough`, so the SDK disconnects the in-process transport — while
   *    still telling the CLI the sdk server exists. The CLI keeps advertising
   *    and routing `mcp__<name>__*`; the next call arrives as an `mcp_message`
   *    control request, finds no transport, and throws
   *    `SDK MCP server not found: <name>` for the REST OF THE ATTEMPT'S LIFE
   *    (the re-fingerprint below is what pins the broken attempt in place).
   *    So we must always splice our owned `instance` back in, and must never
   *    forward a shape-only sdk entry.
   *
   * 2. A server already in `connected` is neither disconnected nor reconnected,
   *    and the CLI is handed a server set identical to the one it already has —
   *    so it never re-issues `tools/list`. Verified empirically against
   *    `claude` CLI 2.1.220: after a single instance-carrying `setMcpServers`,
   *    the tool set the model sees is UNCHANGED, and
   *    `notifications/tools/list_changed` does not move it either (the
   *    notification is delivered; the CLI simply ignores it). `mcp_reconnect`
   *    is not an option — the CLI rejects it for sdk servers with
   *    "SDK servers should be handled in print.ts".
   *
   *    The one mechanism that DOES work is to go with the grain of that diff:
   *    withdraw our server, then reinstate it with the instance. The SDK then
   *    genuinely disconnects and reconnects it, the CLI sees a server set that
   *    changed, and it re-lists — picking up the new specs. Confirmed
   *    empirically: `removed: ["probe"]` then `added: ["probe"]`, a fresh
   *    `tools/list` serving the NEW names, and a subsequent call to a
   *    newly-added tool dispatching successfully.
   *
   * We only pay that two-call dance when the spec set actually changed. An
   * unchanged refresh (common — openclaw re-evaluates tool policy every turn and
   * usually lands on the same answer) takes the single-call path, which
   * preserves the transport and costs no surface churn.
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
    const handle = entry.dynamicTools;

    // Split the requested set into "the sdk server we own" and everything else.
    // An sdk-type entry we do NOT own cannot be honoured: we have no instance
    // for it, and forwarding it verbatim is exactly the bug above. Reject it
    // loudly rather than silently breaking the caller's tool surface.
    const passthrough: Record<string, unknown> = {};
    let ownedName: string | null = null;
    for (const [name, cfg] of Object.entries(params.servers)) {
      if (!isSdkServerConfig(cfg)) {
        passthrough[name] = cfg;
        continue;
      }
      if (!handle) {
        // The attempt was created with no dynamic tools, so there is no
        // in-process server to refresh and we cannot materialise one here.
        // Returning null routes the caller to rotation, which handles it.
        this.logger.info(
          "[attempt-registry] refresh requested an sdk MCP server but this attempt has none; caller should rotate",
          { threadId, server: name },
        );
        return null;
      }
      if (name !== handle.serverName) {
        throw new Error(
          `thread/refresh_tools requested sdk MCP server '${name}', but this bridge only owns '${handle.serverName}'. ` +
            "Refusing to forward it: an sdk entry the bridge cannot back with a live instance would disconnect the transport " +
            "while leaving the server advertised, breaking every subsequent tool call.",
        );
      }
      ownedName = name;
    }

    const specsChanged =
      JSON.stringify(normalizeTools(entry.fingerprintInput.dynamicTools)) !==
      JSON.stringify(normalizeTools(params.dynamicTools));

    // Swap the live surface FIRST, so that whichever `tools/list` the steps
    // below provoke is answered with the new specs.
    handle?.setTools(params.dynamicTools);

    const withInstance: Record<string, unknown> =
      handle && ownedName
        ? { ...passthrough, [ownedName]: { type: "sdk", name: ownedName, instance: handle.instance } }
        : { ...passthrough };

    let result: { added?: string[]; removed?: string[] };
    const relist = Boolean(handle && ownedName && specsChanged);
    if (relist) {
      if (entry.currentHandler !== null) {
        // Not expected — openclaw refreshes between turns — but worth surfacing
        // if it ever happens, because the withdraw/reinstate pair briefly takes
        // the tool surface away from a model that may be mid-decision.
        this.logger.warn(
          "[attempt-registry] re-listing the dynamic tool surface while a turn is in flight",
          { threadId, server: ownedName },
        );
      }
      // Phase 1 — withdraw our sdk server (keeping any caller-supplied non-sdk
      // servers) so the SDK disconnects it and the CLI is told it is gone.
      await entry.query.setMcpServers({ ...passthrough });
      // Phase 2 — reinstate it WITH the live instance. The SDK reconnects the
      // same `McpServer` over a fresh in-process transport (its disconnect
      // closes the transport but does not close the server, so the instance is
      // reusable) and the CLI re-lists, picking up the new specs.
      result = await entry.query.setMcpServers(withInstance);
    } else {
      result = await entry.query.setMcpServers(withInstance);
    }

    // MUST re-fingerprint, and this is the subtle half of the fix. dynamicTools
    // is part of AttemptFingerprintInput, so if the entry kept its old
    // fingerprint the very next turn would compute a mismatch and discard the
    // attempt — respawning the subprocess we just went out of our way not to
    // respawn, and undoing the entire benefit.
    entry.fingerprintInput = { ...entry.fingerprintInput, dynamicTools: params.dynamicTools };
    entry.fingerprint = computeAttemptFingerprint(entry.fingerprintInput);

    // Our own server's churn across the two phases is an artifact of forcing the
    // re-list, not a change in the server SET the caller asked for — it was
    // present before and after. Reporting it would tell openclaw a server
    // appeared when none did.
    const suppress = relist && ownedName ? ownedName : null;
    const added = (result.added ?? []).filter((n) => n !== suppress);
    const removed = (result.removed ?? []).filter((n) => n !== suppress);
    this.logger.info("[attempt-registry] refreshed dynamic tools on a live attempt", {
      threadId,
      toolCount: params.dynamicTools.length,
      relisted: relist,
      added,
      removed,
    });
    return { added, removed };
  }

  size(): number {
    return this.byThread.size;
  }
}

/**
 * True for an MCP server config the SDK will route through its in-process
 * (`sdk`) path — the ones whose transport lifecycle `setMcpServers` manages by
 * the presence of `instance`, and therefore the only ones that need the
 * splice-the-instance-back-in treatment.
 */
function isSdkServerConfig(cfg: unknown): boolean {
  return (
    typeof cfg === "object" &&
    cfg !== null &&
    (cfg as { type?: unknown }).type === "sdk"
  );
}

/** Order- and optional-field-insensitive normalization of a dynamic tool set. */
function normalizeTools(tools: AttemptFingerprintInput["dynamicTools"]) {
  return [...tools]
    .map((t) => ({
      name: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
    dynamicTools: normalizeTools(input.dynamicTools),
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
