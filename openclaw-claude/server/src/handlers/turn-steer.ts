/**
 * `turn/steer` — push an additional user message into a running turn. The
 * controllable input queue on the ActiveTurn picks it up; the SDK consumes
 * it as the next user-turn within the same logical OpenClaw turn.
 *
 * The Anthropic API doesn't support true mid-generation injection, so the
 * steer message arrives at the next user-turn boundary (after the current
 * assistant response finishes). This matches codex's documented behaviour:
 * steer messages queue rather than interrupt.
 */

import type { ActiveTurnRegistry } from "../active-turns.js";
import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type TurnSteerParams,
} from "../protocol.js";
import { RpcError } from "../server.js";
import type { Logger } from "../transport.js";
import { makeSDKUserMessage } from "../user-input.js";

const TURN_NOT_FOUND_CODE = -32005;

export function createTurnSteerHandler(activeTurns: ActiveTurnRegistry, logger: Logger) {
  return async function handleTurnSteer(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const turn = findActiveTurnByThread(activeTurns, params.threadId);
    if (!turn) {
      throw new RpcError(
        TURN_NOT_FOUND_CODE,
        `No active turn for thread ${params.threadId}`,
      );
    }
    if (!turn.inputQueue || turn.inputQueue.isClosed()) {
      // The runner keeps this queue open for the attempt's whole lifetime
      // (see attempt-registry.ts) — reaching here means the turn's attempt
      // has already been torn down (completed, interrupted, or crashed)
      // before this steer arrived.
      throw new RpcError(
        TURN_NOT_FOUND_CODE,
        `Active turn ${turn.turnId} has no open input queue (its attempt is no longer live)`,
      );
    }
    const userMessage = makeSDKUserMessage([{ type: "text", text: params.content }]);
    turn.inputQueue.push(userMessage);
    logger.info("[turn/steer] queued steer message", {
      threadId: turn.threadId,
      turnId: turn.turnId,
      contentLength: params.content.length,
    });
    return { turnId: turn.turnId, note: "queued" };
  };
}

function parseParams(raw: JsonValue | undefined): TurnSteerParams {
  if (
    !isJsonObject(raw) ||
    typeof raw.threadId !== "string" ||
    typeof raw.content !== "string"
  ) {
    throw new RpcError(
      RPC_INVALID_PARAMS,
      "turn/steer requires { threadId: string, content: string }",
    );
  }
  return raw as TurnSteerParams;
}

function findActiveTurnByThread(
  registry: ActiveTurnRegistry,
  threadId: string,
): ReturnType<ActiveTurnRegistry["findByThread"]> {
  return registry.findByThread(threadId);
}
