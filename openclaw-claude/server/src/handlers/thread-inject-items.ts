/**
 * `thread/inject_items` — append opaque transcript entries to a thread's
 * messages.jsonl without running a turn. The caller's items are JsonValue;
 * we round-trip them through JSON.stringify and append one per line.
 *
 * On the next turn, the SDK's resume path will replay these entries via our
 * SessionStore.load.
 */

import { promises as fs } from "node:fs";

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type ThreadInjectItemsParams,
} from "../protocol.js";
import { RpcError } from "../server.js";
import type { ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";

const THREAD_NOT_FOUND_CODE = -32004;

export function createThreadInjectItemsHandler(threadStore: ThreadStore, logger: Logger) {
  return async function handleInjectItems(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const meta = await threadStore.readMeta(params.threadId);
    if (!meta) {
      throw new RpcError(THREAD_NOT_FOUND_CODE, `Thread not found: ${params.threadId}`);
    }
    if (params.items.length === 0) return { injected: 0 };

    const path = threadStore.messagesPath(meta.id);
    const lines = params.items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    try {
      await fs.appendFile(path, lines, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.mkdir(threadStore.threadDir(meta.id), { recursive: true });
        await fs.appendFile(path, lines, "utf8");
      } else {
        logger.warn("[thread/inject_items] append failed", {
          threadId: meta.id,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
    logger.info("[thread/inject_items] appended items", {
      threadId: meta.id,
      count: params.items.length,
    });
    return { injected: params.items.length };
  };
}

function parseParams(raw: JsonValue | undefined): ThreadInjectItemsParams {
  if (
    !isJsonObject(raw) ||
    typeof raw.threadId !== "string" ||
    !Array.isArray(raw.items)
  ) {
    throw new RpcError(
      RPC_INVALID_PARAMS,
      "thread/inject_items requires { threadId: string, items: JsonValue[] }",
    );
  }
  return raw as ThreadInjectItemsParams;
}
