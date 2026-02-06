/**
 * OpenClaw Vestige Plugin
 *
 * Registers cognitive memory tools backed by the Vestige HTTP bridge server.
 * Each tool maps to a FastAPI endpoint which in turn calls vestige-mcp over stdio.
 */

import { Type } from "@sinclair/typebox";

// The OpenClaw plugin API type (provided at runtime)
interface PluginApi {
  registerTool(def: {
    name: string;
    description: string;
    parameters: any;
    execute: (id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }): void;
  getSetting(key: string): string | undefined;
  getAgentId(): string | undefined;
}

/** POST JSON to the Vestige bridge and return the raw text response. */
async function vestigeCall(
  api: PluginApi,
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  const serverUrl = api.getSetting("serverUrl") ?? "http://vestige.internal:8000";
  const token = api.getSetting("authToken") ?? "";
  const agentId = api.getAgentId() ?? "unknown";

  const resp = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Agent-Id": agentId,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    return JSON.stringify({ error: true, status: resp.status, detail });
  }
  return resp.text();
}

/** Wrap a string result in the MCP content format OpenClaw expects. */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── Plugin entry point ───────────────────────────────────────────────────────

export default function (api: PluginApi) {
  // ── vestige_search ─────────────────────────────────────────────────────
  api.registerTool({
    name: "vestige_search",
    description:
      "Search cognitive memory. Supports keyword, semantic, and hybrid modes. " +
      "Returns memories ranked by relevance × retention strength.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query text" }),
      mode: Type.Optional(
        Type.Union([Type.Literal("keyword"), Type.Literal("semantic"), Type.Literal("hybrid")], {
          description: "Search mode (default: hybrid)",
        }),
      ),
      limit: Type.Optional(Type.Integer({ description: "Max results (default: 10)", minimum: 1, maximum: 100 })),
      threshold: Type.Optional(Type.Number({ description: "Min relevance score 0-1" })),
    }),
    async execute(_id, params) {
      return textResult(await vestigeCall(api, "/search", params));
    },
  });

  // ── vestige_ingest ─────────────────────────────────────────────────────
  api.registerTool({
    name: "vestige_ingest",
    description: "Store a memory directly without duplicate detection. Use vestige_smart_ingest for intelligent ingestion.",
    parameters: Type.Object({
      content: Type.String({ description: "Content to store" }),
      node_type: Type.Optional(Type.String({ description: "Memory type: fact, concept, event, etc." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for organization" })),
      context: Type.Optional(Type.String({ description: "Optional context" })),
    }),
    async execute(_id, params) {
      return textResult(await vestigeCall(api, "/ingest", params));
    },
  });

  // ── vestige_smart_ingest ───────────────────────────────────────────────
  api.registerTool({
    name: "vestige_smart_ingest",
    description:
      "Intelligently ingest a memory with prediction error gating — automatically detects duplicates " +
      "and decides whether to CREATE, UPDATE, REINFORCE, or SUPERSEDE existing memories.",
    parameters: Type.Object({
      content: Type.String({ description: "Content to store" }),
      node_type: Type.Optional(Type.String({ description: "Memory type: fact, concept, event, etc." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
      context: Type.Optional(Type.String({ description: "Optional context" })),
    }),
    async execute(_id, params) {
      return textResult(await vestigeCall(api, "/smart_ingest", params));
    },
  });

  // ── vestige_promote ────────────────────────────────────────────────────
  api.registerTool({
    name: "vestige_promote",
    description: "Mark a memory as helpful / correct — strengthens its retention and retrieval strength.",
    parameters: Type.Object({
      memory_id: Type.String({ description: "Memory ID to promote" }),
    }),
    async execute(_id, params) {
      return textResult(await vestigeCall(api, "/promote", params));
    },
  });

  // ── vestige_demote ─────────────────────────────────────────────────────
  api.registerTool({
    name: "vestige_demote",
    description: "Mark a memory as wrong / unhelpful — weakens its retention strength.",
    parameters: Type.Object({
      memory_id: Type.String({ description: "Memory ID to demote" }),
    }),
    async execute(_id, params) {
      return textResult(await vestigeCall(api, "/demote", params));
    },
  });
}
