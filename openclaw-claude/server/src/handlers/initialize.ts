/**
 * The `initialize` handshake. Mirrors what codex-app-server returns: a
 * `userAgent` string the codex client parses for version checks plus a small
 * `serverInfo` block. The protocol version reported here is the codex
 * protocol revision we claim to implement.
 */

import {
  isJsonObject,
  RPC_INVALID_PARAMS,
  type InitializeParams,
  type InitializeResponse,
  type JsonValue,
} from "../protocol.js";
import { RpcError } from "../server.js";
import {
  OPENCLAW_CLAUDE_APP_SERVER_NAME,
  OPENCLAW_CLAUDE_APP_SERVER_VERSION,
  REPORTED_PROTOCOL_VERSION,
} from "../version.js";

export type InitializeState = {
  initialized: boolean;
  clientName?: string;
  clientVersion?: string;
};

export function createInitializeHandler(state: InitializeState) {
  return async function handleInitialize(rawParams: JsonValue | undefined): Promise<JsonValue> {
    const params = parseInitializeParams(rawParams);
    state.initialized = true;
    state.clientName = params.clientInfo.name;
    state.clientVersion = params.clientInfo.version;

    const response: InitializeResponse = {
      serverInfo: {
        name: OPENCLAW_CLAUDE_APP_SERVER_NAME,
        version: OPENCLAW_CLAUDE_APP_SERVER_VERSION,
      },
      protocolVersion: REPORTED_PROTOCOL_VERSION,
      // Codex's client extracts the leading product/version from this string;
      // see openclaw/extensions/codex/src/app-server/client.ts readCodexVersionFromUserAgent.
      userAgent: `${OPENCLAW_CLAUDE_APP_SERVER_NAME}/${REPORTED_PROTOCOL_VERSION} (sdk=@anthropic-ai/claude-agent-sdk)`,
      capabilities: {
        experimentalApi: true,
      },
    };
    return response as unknown as JsonValue;
  };
}

function parseInitializeParams(raw: JsonValue | undefined): InitializeParams {
  if (!isJsonObject(raw)) {
    throw new RpcError(RPC_INVALID_PARAMS, "initialize requires an object params");
  }
  const clientInfo = raw.clientInfo;
  if (!isJsonObject(clientInfo) || typeof clientInfo.name !== "string") {
    throw new RpcError(RPC_INVALID_PARAMS, "initialize.clientInfo.name is required");
  }
  return {
    clientInfo: {
      name: clientInfo.name,
      title: typeof clientInfo.title === "string" ? clientInfo.title : undefined,
      version: typeof clientInfo.version === "string" ? clientInfo.version : undefined,
    },
    capabilities: isJsonObject(raw.capabilities) ? raw.capabilities : undefined,
  };
}
