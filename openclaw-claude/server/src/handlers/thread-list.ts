/**
 * `thread/list` handler. Enumerates persisted thread metadata (ThreadStore
 * already keeps one meta.json per thread on disk — see thread-store.ts) and
 * cross-references the in-memory AttemptRegistry for live status, mirroring
 * codex's thread/list semantics: archived threads are hidden unless
 * explicitly requested, and `turns` stays empty (codex only populates turns
 * on thread/resume, thread/fork, and thread/read).
 *
 * Preview text requires reading each thread's messages.jsonl, which is only
 * worth doing for the page actually being returned — computed after
 * filter+sort+paginate, not for the whole store.
 */

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type JsonValue,
  type ThreadListParams,
  type ThreadListResponse,
} from "../protocol.js";
import { RpcError } from "../server.js";
import { derivePreview, metaToThread } from "../thread-mapper.js";
import type { ThreadMeta, ThreadStore } from "../thread-store.js";
import type { Logger } from "../transport.js";
import type { AttemptRegistry } from "../attempt-registry.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function createThreadListHandler(
  threadStore: ThreadStore,
  attemptRegistry: AttemptRegistry,
  logger: Logger,
) {
  return async function handleThreadList(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const all = await threadStore.listThreads();

    let filtered = all.filter((meta) => Boolean(meta.archived) === (params.archived === true));
    if (params.modelProviders && params.modelProviders.length > 0) {
      const allowed = new Set(params.modelProviders);
      filtered = filtered.filter((meta) => allowed.has(meta.modelProvider));
    }
    if (params.searchTerm && params.searchTerm.trim().length > 0) {
      const needle = params.searchTerm.trim().toLowerCase();
      filtered = filtered.filter(
        (meta) =>
          (meta.name ?? "").toLowerCase().includes(needle) ||
          meta.cwd.toLowerCase().includes(needle),
      );
    }

    filtered.sort(comparatorFor(params.sortKey ?? "updated_at", params.sortDirection ?? "desc"));

    const limit = clampLimit(params.limit);
    const startIndex = resolveCursorIndex(filtered, params.cursor);
    const page = filtered.slice(startIndex, startIndex + limit);
    const nextIndex = startIndex + limit;
    const nextCursor = nextIndex < filtered.length ? page[page.length - 1]?.id ?? null : null;

    const data = await Promise.all(
      page.map(async (meta) => {
        const attempt = attemptRegistry.get(meta.id);
        return metaToThread(meta, {
          status: attempt && !attempt.closed ? { type: "active" } : { type: "idle" },
          turns: [],
          preview: await derivePreview(threadStore.messagesPath(meta.id)),
        });
      }),
    );

    const response: ThreadListResponse = {
      data,
      nextCursor,
      backwardsCursor: startIndex > 0 ? (filtered[Math.max(0, startIndex - 1)]?.id ?? null) : null,
    };

    logger.info("[thread/list] listed", { count: data.length, archived: params.archived === true });
    return response as unknown as JsonValue;
  };
}

function parseParams(raw: JsonValue | undefined): ThreadListParams {
  if (raw === undefined) return {};
  if (!isJsonObject(raw)) {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/list params must be an object");
  }
  return raw as ThreadListParams;
}

function clampLimit(requested: number | null | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_LIMIT);
}

function resolveCursorIndex(sorted: ThreadMeta[], cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const idx = sorted.findIndex((meta) => meta.id === cursor);
  return idx === -1 ? 0 : idx + 1;
}

function comparatorFor(
  sortKey: "created_at" | "updated_at" | "recency_at",
  direction: "asc" | "desc",
): (a: ThreadMeta, b: ThreadMeta) => number {
  // We don't track a distinct "recency" signal (last-interacted-with vs.
  // last-updated) separately, so recency_at aliases updated_at.
  const key: "createdAt" | "updatedAt" = sortKey === "created_at" ? "createdAt" : "updatedAt";
  const sign = direction === "asc" ? 1 : -1;
  return (a, b) => sign * (a[key] - b[key]);
}
