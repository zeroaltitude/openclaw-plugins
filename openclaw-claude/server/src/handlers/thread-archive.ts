/**
 * `thread/archive` / `thread/unarchive` handlers. Soft-delete via a metadata
 * flag — never touches the thread directory or transcript — so archiving is
 * always reversible via unarchive. Pure metadata update, no SDK/subprocess
 * involvement.
 *
 * Codex parity note (intentionally asymmetric, mirrored as-is):
 * thread/archive returns void; thread/unarchive returns the restored thread.
 */

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type ThreadArchiveParams,
  type ThreadUnarchiveResponse,
} from "../protocol.js";
import { RpcError } from "../server.js";
import { derivePreview, metaToThread } from "../thread-mapper.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";

const THREAD_NOT_FOUND_CODE = -32004;

export function createThreadArchiveHandler(threadStore: ThreadStore, logger: Logger) {
  return async function handleThreadArchive(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams, "thread/archive");
    const updated = await threadStore.updateMeta(params.threadId, {
      archived: true,
      archivedAt: Math.floor(Date.now() / 1000),
    });
    if (!updated) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }
    logger.info("[thread/archive] archived", { threadId: params.threadId });
    return {};
  };
}

export function createThreadUnarchiveHandler(threadStore: ThreadStore, logger: Logger) {
  return async function handleThreadUnarchive(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams, "thread/unarchive");
    const updated = await threadStore.updateMeta(params.threadId, {
      archived: false,
      archivedAt: null,
    });
    if (!updated) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }
    const response: ThreadUnarchiveResponse = {
      thread: metaToThread(updated, {
        status: { type: "idle" },
        turns: [],
        preview: await derivePreview(threadStore.messagesPath(updated.id)),
      }),
    };
    logger.info("[thread/unarchive] unarchived", { threadId: params.threadId });
    return response as unknown as JsonValue;
  };
}

function parseParams(raw: JsonValue | undefined, method: string): ThreadArchiveParams {
  if (!isJsonObject(raw) || typeof raw.threadId !== "string") {
    throw new RpcError(RPC_INVALID_PARAMS, `${method} requires { threadId: string }`);
  }
  return raw as ThreadArchiveParams;
}
