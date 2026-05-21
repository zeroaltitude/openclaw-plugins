/**
 * `turn/interrupt` handler. Aborts the in-flight Query via the AbortController
 * we registered when the turn started. The runner's catch path then emits the
 * terminal `turn/completed` (status="aborted") notification.
 */

import type { ActiveTurnRegistry } from "../active-turns.js";
import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type TurnInterruptParams,
} from "../protocol.js";
import { RpcError } from "../server.js";
import type { Logger } from "../transport.js";

const TURN_NOT_FOUND_CODE = -32005;

export function createTurnInterruptHandler(activeTurns: ActiveTurnRegistry, logger: Logger) {
  return async function handleTurnInterrupt(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const turn = activeTurns.find(params.threadId, params.turnId);
    if (!turn) {
      throw new RpcError(TURN_NOT_FOUND_CODE, `Turn not active: ${params.turnId}`);
    }
    if (turn.abortController.signal.aborted) {
      logger.debug("[turn/interrupt] already aborted", { turnId: params.turnId });
    } else {
      turn.abortController.abort();
      logger.info("[turn/interrupt] aborted turn", { turnId: params.turnId });
    }
    return { turnId: params.turnId, status: "aborted" } as unknown as JsonValue;
  };
}

function parseParams(raw: JsonValue | undefined): TurnInterruptParams {
  if (
    !isJsonObject(raw) ||
    typeof raw.threadId !== "string" ||
    typeof raw.turnId !== "string"
  ) {
    throw new RpcError(
      RPC_INVALID_PARAMS,
      "turn/interrupt requires { threadId: string, turnId: string }",
    );
  }
  return raw as TurnInterruptParams;
}
