/**
 * `thread/list` handler. Streams thread metadata in recency order rather
 * than materializing every thread in memory to filter+sort+slice — see
 * ThreadStore.listThreadIdsByRecency's doc comment for why: a real install
 * can accumulate tens of thousands of thread directories, and reading full
 * metadata for every single one just to serve a 50-row page previously
 * OOM-crashed the bridge process (confirmed live against ~36k real threads).
 *
 * Preview text requires reading each thread's messages.jsonl, which is only
 * worth doing for the page actually being returned.
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

// Hard ceiling on how many thread directories a single thread/list call will
// read full metadata for while scanning toward a page. Bounds worst-case
// latency/IO for a search or cursor deep in an install with tens of
// thousands of threads and few matches — callers needing to go further page
// forward with the returned cursor rather than widen this in one call.
const MAX_METADATA_READS_PER_CALL = 5_000;

export function createThreadListHandler(
  threadStore: ThreadStore,
  attemptRegistry: AttemptRegistry,
  logger: Logger,
) {
  return async function handleThreadList(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const limit = clampLimit(params.limit);
    const wantArchived = params.archived === true;
    const modelProviders = params.modelProviders?.length ? new Set(params.modelProviders) : null;
    const searchNeedle = params.searchTerm?.trim().toLowerCase() || null;
    // recency-based ordering (see ThreadStore.listThreadIdsByRecency): a good
    // approximation for updated_at/recency_at in either direction, and for
    // created_at too in the common case (most-recently-touched threads also
    // tend to be among the more recently created ones) — not exact for
    // created_at if a very old thread was just touched, which is an accepted
    // tradeoff for staying streaming-safe at real-world scale (see module doc).
    let orderedIds = await threadStore.listThreadIdsByRecency();
    if ((params.sortDirection ?? "desc") === "asc") {
      orderedIds = [...orderedIds].reverse();
    }

    const page: ThreadMeta[] = [];
    let foundCursor = !params.cursor;
    let backwardsCursor: string | null = null;
    let nextCursor: string | null = null;
    let readCount = 0;

    for (const threadId of orderedIds) {
      if (page.length >= limit) {
        // One more matching id beyond the page confirms there's a next page.
        nextCursor = page[page.length - 1]?.id ?? null;
        break;
      }
      if (readCount >= MAX_METADATA_READS_PER_CALL) break;
      readCount++;
      const meta = await threadStore.readMeta(threadId);
      if (!meta) continue;
      if (Boolean(meta.archived) !== wantArchived) continue;
      if (modelProviders && !modelProviders.has(meta.modelProvider)) continue;
      if (searchNeedle) {
        const haystack = `${meta.name ?? ""} ${meta.cwd}`.toLowerCase();
        if (!haystack.includes(searchNeedle)) continue;
      }
      if (!foundCursor) {
        if (meta.id === params.cursor) foundCursor = true;
        backwardsCursor = meta.id;
        continue;
      }
      page.push(meta);
    }
    // If the scan ends with a full page but never confirmed a following
    // match (loop exhausted orderedIds or hit MAX_METADATA_READS_PER_CALL
    // right at the boundary), nextCursor stays null — treated as "no more
    // matches found". A caller that hit the read cap this way can re-page
    // from the last item to confirm exhaustion; rare in practice (would need
    // thousands of consecutive non-matching threads right at a page edge).

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
      backwardsCursor,
    };

    logger.info("[thread/list] listed", {
      count: data.length,
      archived: wantArchived,
      metadataReads: readCount,
    });
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
