/**
 * `thread/name/set` handler. Pure metadata update — no SDK/subprocess
 * involvement, mirroring codex's thread/name/set.
 */

import { isJsonObject, RPC_INVALID_PARAMS, type JsonValue, type ThreadSetNameParams } from "../protocol.js";
import { RpcError } from "../server.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";

const THREAD_NOT_FOUND_CODE = -32004;

export function createThreadSetNameHandler(threadStore: ThreadStore, logger: Logger) {
  return async function handleThreadSetName(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const updated = await threadStore.updateMeta(params.threadId, { name: params.name });
    if (!updated) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }
    logger.info("[thread/name/set] renamed", { threadId: params.threadId, name: params.name });
    return {};
  };
}

function parseParams(raw: JsonValue | undefined): ThreadSetNameParams {
  if (!isJsonObject(raw) || typeof raw.threadId !== "string" || typeof raw.name !== "string") {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/name/set requires { threadId: string, name: string }");
  }
  return raw as ThreadSetNameParams;
}
