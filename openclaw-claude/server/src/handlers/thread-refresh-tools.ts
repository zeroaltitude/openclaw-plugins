/**
 * `thread/refresh_tools` handler.
 *
 * Applies a new dynamic tool surface to an ALREADY-RUNNING attempt via the
 * SDK's `Query.setMcpServers`, instead of the caller having to rotate the
 * thread to get the new tools registered.
 *
 * Why this exists: a tool-catalog change used to force a new SDK session,
 * which costs a full transcript copy, a fresh session id (so a cold prompt
 * cache) and a respawned subprocess that strands anything the previous turn
 * backgrounded. Catalog changes are frequently POLICY rather than
 * configuration — e.g. the gateway's owner-only control-plane deny, which
 * varies per turn — so paying that price repeatedly was pure waste.
 *
 * The caller MUST treat `{ refreshed: false }` as "rotate instead": it means
 * there is no live attempt to refresh (never started, already swept, or
 * discarded), not that the tools are somehow current.
 */

import type { AttemptRegistry } from "../attempt-registry.js";
import { isJsonObject, RPC_INVALID_PARAMS, type JsonValue } from "../protocol.js";
import { RpcError } from "../server.js";
import type { Logger } from "../transport.js";

type RefreshToolsParams = {
  threadId: string;
  servers: Record<string, unknown>;
  dynamicTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
};

export function createThreadRefreshToolsHandler(
  attemptRegistry: AttemptRegistry,
  logger: Logger,
) {
  return async function handleThreadRefreshTools(
    rawParams: JsonValue | undefined,
  ): Promise<JsonValue> {
    const params = parseParams(rawParams);
    const result = await attemptRegistry.refreshDynamicTools(params.threadId, {
      servers: params.servers,
      dynamicTools: params.dynamicTools,
    });
    if (!result) {
      logger.debug("[thread/refresh_tools] no live attempt; caller should rotate", {
        threadId: params.threadId,
      });
      return { refreshed: false } as JsonValue;
    }
    return {
      refreshed: true,
      added: result.added,
      removed: result.removed,
    } as unknown as JsonValue;
  };
}

function parseParams(raw: JsonValue | undefined): RefreshToolsParams {
  if (!isJsonObject(raw)) {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/refresh_tools requires an object");
  }
  const threadId = raw.threadId;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/refresh_tools requires { threadId: string }");
  }
  const servers = raw.servers;
  if (!isJsonObject(servers)) {
    throw new RpcError(RPC_INVALID_PARAMS, "thread/refresh_tools requires { servers: object }");
  }
  const dynamicTools = raw.dynamicTools;
  if (!Array.isArray(dynamicTools)) {
    throw new RpcError(
      RPC_INVALID_PARAMS,
      "thread/refresh_tools requires { dynamicTools: array }",
    );
  }
  const parsedTools: RefreshToolsParams["dynamicTools"] = [];
  for (const tool of dynamicTools) {
    if (!isJsonObject(tool) || typeof tool.name !== "string") {
      throw new RpcError(
        RPC_INVALID_PARAMS,
        "thread/refresh_tools dynamicTools entries require a string name",
      );
    }
    parsedTools.push({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    });
  }
  return {
    threadId,
    servers: servers as Record<string, unknown>,
    dynamicTools: parsedTools,
  };
}
