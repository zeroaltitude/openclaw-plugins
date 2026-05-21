/**
 * `thread/unsubscribe` — codex clients send this to stop receiving
 * notifications for a thread. We don't track per-client subscriptions
 * (notifications are broadcast on stdio anyway), so this is a successful
 * no-op. We still validate the params and surface a thread-not-found error
 * if the threadId is bogus, so callers get the same feedback codex provides.
 */

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type ThreadUnsubscribeParams,
} from "../protocol.js";
import { RpcError } from "../server.js";
import type { ThreadStore } from "../thread-store.js";

const THREAD_NOT_FOUND_CODE = -32004;

export function createThreadUnsubscribeHandler(threadStore: ThreadStore) {
  return async function handleUnsubscribe(rawParams: JsonValue | undefined): Promise<JsonValue> {
    if (!isJsonObject(rawParams) || typeof rawParams.threadId !== "string") {
      throw new RpcError(
        RPC_INVALID_PARAMS,
        "thread/unsubscribe requires { threadId: string }",
      );
    }
    const params = rawParams as ThreadUnsubscribeParams;
    const meta = await threadStore.readMeta(params.threadId);
    if (!meta) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }
    return {};
  };
}
