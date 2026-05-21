/**
 * In-process MCP server that exposes codex's `dynamicTools` to the underlying
 * Claude Agent SDK without going through Zod.
 *
 * We construct a bare `McpServer` and bypass its `registerTool()` helper —
 * which would force Zod schemas — by setting raw request handlers on the
 * underlying `Server` for `tools/list` and `tools/call`. That lets us hand
 * Claude the JSON Schema verbatim as the plugin sent it, with no conversion
 * round-trip.
 *
 * On `tools/call` we forward to the openclaw plugin via a server→client
 * JSON-RPC request shaped per codex's `DynamicToolCallParams`, and translate
 * the codex `DynamicToolCallResponse` back into the MCP `CallToolResult`
 * the SDK expects.
 */

import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type {
  DynamicToolCallOutputContentItem,
  DynamicToolSpec,
} from "./protocol.js";
import type { Logger } from "./transport.js";

export type ToolCallContext = {
  threadId: string;
  turnId: string;
};

export type DynamicToolCallResponse = {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
  diagnosticTerminalType?: string;
};

/**
 * Bridge to the openclaw plugin. The MCP handler calls this; the
 * implementation issues a server→client JSON-RPC request and translates
 * the codex response shape to whatever the caller needs.
 */
export type ToolCallBridge = (params: {
  ctx: ToolCallContext;
  callId: string;
  tool: string;
  args: unknown;
}) => Promise<DynamicToolCallResponse>;

export type DynamicToolsHandle = {
  instance: McpServer;
  /** Updated by the turn runner before each turn so the bridge knows which turn it is. */
  ctxRef: { current: ToolCallContext | null };
};

export function buildDynamicToolsMcpServer(opts: {
  serverName: string;
  tools: DynamicToolSpec[];
  bridge: ToolCallBridge;
  /** Called whenever a tool is invoked, before the bridge runs. */
  onCallStart?: (info: { tool: string; callId: string; args: unknown; ctx: ToolCallContext }) => void;
  /** Called when a tool call completes (success or error). */
  onCallEnd?: (info: {
    tool: string;
    callId: string;
    ctx: ToolCallContext;
    response: DynamicToolCallResponse;
    durationMs: number;
  }) => void;
  logger: Logger;
}): DynamicToolsHandle {
  const ctxRef: { current: ToolCallContext | null } = { current: null };

  // We bypass McpServer.registerTool() to keep raw JSON Schema, so we must
  // declare the `tools` capability ourselves — registerTool would have done
  // it as a side effect. Without this, the SDK refuses to call `tools/list`
  // with the error "Server does not support tools".
  const instance = new McpServer(
    { name: opts.serverName, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));

  // tools/list — raw JSON Schema pass-through.
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.tools.map((spec) => {
      const inputSchema = spec.inputSchema ?? { type: "object", additionalProperties: true };
      return {
        name: spec.name,
        description: spec.description,
        inputSchema: inputSchema as Record<string, unknown>,
      };
    }),
  }));

  // tools/call — forward to the plugin via the bridge.
  instance.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (!toolByName.has(name)) {
      return errorResult(`Unknown dynamic tool: ${name}`);
    }
    const ctx = ctxRef.current;
    if (!ctx) {
      return errorResult("Dynamic tool invoked outside an active turn");
    }
    const callId = randomUUID();
    opts.onCallStart?.({ tool: name, callId, args, ctx });
    const startedAt = Date.now();
    try {
      const response = await opts.bridge({ ctx, callId, tool: name, args });
      const durationMs = Date.now() - startedAt;
      opts.onCallEnd?.({ tool: name, callId, ctx, response, durationMs });
      return {
        content: response.contentItems.map(toMcpContent),
        isError: !response.success,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : String(err);
      opts.logger.warn("[dynamic-tools] bridge threw", { tool: name, error: msg });
      const response: DynamicToolCallResponse = {
        contentItems: [{ type: "inputText", text: `Tool execution failed: ${msg}` }],
        success: false,
      };
      opts.onCallEnd?.({ tool: name, callId, ctx, response, durationMs });
      return { content: response.contentItems.map(toMcpContent), isError: true };
    }
  });

  return { instance, ctxRef };
}

function toMcpContent(item: DynamicToolCallOutputContentItem): Record<string, unknown> {
  if (item && typeof item === "object" && "type" in item) {
    if (item.type === "inputText" && typeof (item as { text?: unknown }).text === "string") {
      return { type: "text", text: (item as { text: string }).text };
    }
    if (item.type === "inputImage" && typeof (item as { imageUrl?: unknown }).imageUrl === "string") {
      // MCP's image content type wants base64 + mimeType; we surface the URL
      // as text for phase 5. Phase 6 (image work) can fetch + base64-encode.
      return { type: "text", text: `[image: ${(item as { imageUrl: string }).imageUrl}]` };
    }
  }
  // Arbitrary JSON content from the plugin — stringify so the model still
  // sees something useful instead of nothing.
  return { type: "text", text: JSON.stringify(item) };
}

function errorResult(message: string): { content: Array<Record<string, unknown>>; isError: boolean } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
