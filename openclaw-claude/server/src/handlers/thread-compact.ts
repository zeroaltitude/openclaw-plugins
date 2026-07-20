/**
 * `thread/compact/start` handler. Mirrors codex's native-compaction
 * capability: synchronously allocates a turnId, registers the active turn,
 * returns an initial `{turn}` response (status "inProgress"), then drives the
 * SDK's own `/compact` slash command through the thread's attempt (reusing a
 * live subprocess when one exists — so the compaction happens in the REAL
 * model context — or resuming from the on-disk transcript when none does).
 *
 * Completion is signalled by notifications, in order:
 *   - `thread/compact/boundary`  (from turn-runner, when the SDK's
 *     compact_boundary system message arrives — carries token accounting)
 *   - `thread/compact/completed` (terminal compaction outcome; ALWAYS emitted)
 *   - `turn/completed`           (the compaction turn's own terminal record)
 *
 * After the turn settles, turn-runner discards the attempt so the next turn
 * resumes from the compacted transcript (see RunTurnInput.compactMode).
 */

import { randomUUID } from "node:crypto";

import type { ActiveTurnRegistry } from "../active-turns.js";
import type { AttemptRegistry } from "../attempt-registry.js";
import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type ThreadCompactCompletedNotification,
  type ThreadCompactStartParams,
  type ThreadCompactStartResponse,
  type Turn,
} from "../protocol.js";
import { RpcError } from "../server.js";
import type { OpenClawSessionStore } from "../session-store.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";
import { runTurn, type TurnCompactionOutcome } from "../turn-runner.js";
import { validateOutbound } from "../validators.js";

const THREAD_NOT_FOUND_CODE = -32004;

export type ThreadCompactStartHandlerDeps = {
  threadStore: ThreadStore;
  sessionStore: OpenClawSessionStore;
  activeTurns: ActiveTurnRegistry;
  attemptRegistry: AttemptRegistry;
  notify: (method: string, params: unknown) => void;
  requestClient: (
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<unknown>;
  logger: Logger;
};

export function createThreadCompactStartHandler(deps: ThreadCompactStartHandlerDeps) {
  return async function handleThreadCompactStart(
    rawParams: JsonValue | undefined,
  ): Promise<JsonValue> {
    const params = parseThreadCompactStartParams(rawParams);
    const meta = await deps.threadStore.readMeta(params.threadId);
    if (!meta) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }

    const turnId = randomUUID();
    const startedAtMs = Date.now();
    const startedAtSeconds = Math.floor(startedAtMs / 1000);
    const abortController = new AbortController();

    const active = {
      threadId: meta.id,
      turnId,
      abortController,
      startedAtSeconds,
      startedAtMs,
      items: [],
      status: "inProgress" as const,
    };
    deps.activeTurns.register(active);

    // Kick off the runner; do NOT await it. The handler returns the initial
    // turn record synchronously; completion flows through notifications.
    void (async () => {
      try {
        const { finalTurn, compaction } = await runTurn({
          meta,
          turn: active,
          input: [{ type: "text", text: "/compact" }],
          effort: null,
          compactMode: true,
          sessionStore: deps.sessionStore,
          threadStore: deps.threadStore,
          attemptRegistry: deps.attemptRegistry,
          notify: deps.notify,
          requestClient: deps.requestClient,
          logger: deps.logger,
        });
        deps.notify(
          "thread/compact/completed",
          buildCompactCompletedNotification({
            threadId: meta.id,
            turnId,
            compaction,
            turnStatus: finalTurn.status,
            turnErrorMessage: finalTurn.error?.message,
          }),
        );
        if (finalTurn.error) {
          deps.notify("turn/error", { turnId, threadId: meta.id, error: finalTurn.error });
        }
        deps.notify("turn/completed", { threadId: meta.id, turn: finalTurn });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.error("[thread/compact/start] runner crashed", { turnId, error: message });
        const nowMs = Date.now();
        deps.notify("thread/compact/completed", {
          threadId: meta.id,
          turnId,
          compacted: false,
          error: { message },
        } satisfies ThreadCompactCompletedNotification);
        deps.notify("turn/error", { turnId, threadId: meta.id, error: { message } });
        // Always emit a terminal turn/completed so the client never hangs
        // waiting for it, even when the runner itself threw.
        const failureTurn: Turn = {
          id: turnId,
          threadId: meta.id,
          status: "failed",
          startedAt: startedAtSeconds,
          completedAt: Math.floor(nowMs / 1000),
          durationMs: nowMs - startedAtMs,
          items: active.items,
          error: { message },
        };
        deps.notify("turn/completed", { threadId: meta.id, turn: failureTurn });
      } finally {
        deps.activeTurns.remove(turnId);
      }
    })();

    const initialTurn: Turn = {
      id: turnId,
      threadId: meta.id,
      status: "inProgress",
      startedAt: startedAtSeconds,
      completedAt: null,
      durationMs: null,
      items: [],
    };
    const response: ThreadCompactStartResponse = { turn: initialTurn };
    // Same wire shape as turn/start's initial response.
    validateOutbound("turnStart", response, deps.logger);
    return response as unknown as JsonValue;
  };
}

/**
 * Maps a finished compaction turn onto the terminal notification. Success is
 * primarily the SDK's `compact_result: "success"` status; a `compact_boundary`
 * on a cleanly-completed turn counts too (older CLIs emit the boundary
 * without a status report). Everything else is a non-compaction: the turn
 * failed, or the SDK treated `/compact` as an ordinary message.
 */
function buildCompactCompletedNotification(input: {
  threadId: string;
  turnId: string;
  compaction: TurnCompactionOutcome | undefined;
  turnStatus: Turn["status"];
  turnErrorMessage: string | undefined;
}): ThreadCompactCompletedNotification {
  const boundary = input.compaction?.boundary;
  const compacted =
    input.compaction?.result === "success" ||
    (input.compaction?.result === undefined &&
      boundary !== undefined &&
      input.turnStatus === "completed");
  const errorMessage = compacted
    ? undefined
    : (input.compaction?.error ??
      input.turnErrorMessage ??
      (input.compaction?.result === "failed"
        ? "SDK reported compaction failure"
        : "SDK did not report a compaction for this thread"));
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    compacted,
    ...(boundary?.trigger !== undefined ? { trigger: boundary.trigger } : {}),
    ...(boundary?.preTokens !== undefined ? { preTokens: boundary.preTokens } : {}),
    ...(boundary?.postTokens !== undefined ? { postTokens: boundary.postTokens } : {}),
    ...(boundary?.durationMs !== undefined ? { durationMs: boundary.durationMs } : {}),
    ...(errorMessage ? { error: { message: errorMessage } } : {}),
  };
}

function parseThreadCompactStartParams(raw: JsonValue | undefined): ThreadCompactStartParams {
  if (!isJsonObject(raw) || typeof raw.threadId !== "string" || !raw.threadId.trim()) {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/compact/start requires { threadId: string }");
  }
  return raw as ThreadCompactStartParams;
}
