/**
 * `turn/start` handler. Synchronously allocates a turnId, registers the
 * active turn, returns an initial `{turn}` response (items=[], status=
 * "in_progress"), then kicks off the turn runner asynchronously. The runner
 * streams notifications and emits a terminal `turn/completed` notification
 * when the SDK's `result` message arrives.
 */

import { randomUUID } from "node:crypto";

import type { ActiveTurnRegistry } from "../active-turns.js";
import type { AttemptRegistry } from "../attempt-registry.js";
import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type ReasoningEffort,
  type Turn,
  type TurnStartParams,
  type TurnStartResponse,
  type UserInput,
} from "../protocol.js";
import { RpcError } from "../server.js";
import type { OpenClawSessionStore } from "../session-store.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";
import { runTurn } from "../turn-runner.js";
import { validateOutbound } from "../validators.js";

const VALID_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

const THREAD_NOT_FOUND_CODE = -32004;

export type TurnStartHandlerDeps = {
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

export function createTurnStartHandler(deps: TurnStartHandlerDeps) {
  return async function handleTurnStart(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseTurnStartParams(rawParams);
    const meta = await deps.threadStore.readMeta(params.threadId);
    if (!meta) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }

    const input = normalizeInput(params.input);

    const effort = parseEffort(params.effort);
    const modelOverride = typeof params.model === "string" ? params.model : undefined;
    const fastMode = params.fastMode === true;
    const oneShot = params.oneShot === true;

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

    // Receipt log BEFORE the async runner kicks off: when a client observes a
    // lost/unacknowledged turn/start (seen 2026-07-31: four turns vanished
    // between client send and turn creation), this line discriminates
    // "request never arrived" from "arrived but the ack/response was lost".
    deps.logger.info("[turn/start] received", {
      threadId: meta.id,
      turnId,
      model: modelOverride ?? meta.model,
      oneShot,
    });
    // Kick off the runner; do NOT await it. The handler returns the initial
    // turn record synchronously so the JSON-RPC response goes out before the
    // streaming notifications.
    void (async () => {
      try {
        const { finalTurn } = await runTurn({
          meta,
          turn: active,
          input,
          effort,
          fastMode,
          oneShot,
          modelOverride,
          collaborationMode: params.collaborationMode ?? null,
          sessionStore: deps.sessionStore,
          threadStore: deps.threadStore,
          attemptRegistry: deps.attemptRegistry,
          notify: deps.notify,
          requestClient: deps.requestClient,
          logger: deps.logger,
        });
        if (finalTurn.error) {
          deps.notify("turn/error", { turnId, threadId: meta.id, error: finalTurn.error });
        }
        // turn/completed requires top-level threadId per codex's schema
        // (TurnCompletedNotification.json requires {threadId, turn}).
        deps.notify("turn/completed", { threadId: meta.id, turn: finalTurn });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.error("[turn/start] runner crashed", { turnId, error: message });
        const nowMs = Date.now();
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
    const response: TurnStartResponse = { turn: initialTurn };
    validateOutbound("turnStart", response, deps.logger);
    return response as unknown as JsonValue;
  };
}

function parseTurnStartParams(raw: JsonValue | undefined): TurnStartParams {
  if (!isJsonObject(raw) || typeof raw.threadId !== "string") {
    throw new RpcError(RPC_INVALID_PARAMS, "turn/start requires { threadId: string, ... }");
  }
  return raw as TurnStartParams;
}

function normalizeInput(raw: TurnStartParams["input"]): UserInput[] {
  if (!Array.isArray(raw)) return [];
  const out: UserInput[] = [];
  for (const block of raw) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown; url?: unknown; path?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "image" && typeof b.url === "string") {
      out.push({ type: "image", url: b.url });
    } else if (b.type === "localImage" && typeof b.path === "string") {
      out.push({ type: "localImage", path: b.path });
    }
  }
  return out;
}

function parseEffort(raw: unknown): ReasoningEffort | null {
  if (typeof raw !== "string") return null;
  return VALID_EFFORTS.includes(raw as ReasoningEffort) ? (raw as ReasoningEffort) : null;
}
