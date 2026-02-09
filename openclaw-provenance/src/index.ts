/**
 * OpenClaw Vestige Plugin
 *
 * Registers cognitive memory tools backed by the Vestige HTTP bridge server.
 * Each tool maps to a FastAPI endpoint which in turn calls vestige-mcp over stdio.
 */

import { Type } from "@sinclair/typebox";
import { registerSecurityHooks } from "./security/index.js";

// The OpenClaw plugin API type (provided at runtime)
interface PluginApi {
  registerTool(def: {
    name: string;
    description: string;
    parameters: any;
    execute: (id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }): void;
  registerHook(events: string | string[], handler: (...args: any[]) => any, opts?: { priority?: number }): void;
  on(hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }): void;
  pluginConfig: Record<string, unknown> | undefined;
  config: Record<string, unknown>;
  logger: { info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
}

/** Default request timeout in milliseconds (30s). */
const REQUEST_TIMEOUT_MS = 30_000;

/** POST JSON to the Vestige bridge and return parsed response data. */
async function vestigeCall(
  api: PluginApi,
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  let serverUrl = (cfg.serverUrl as string) ?? "http://vestige.internal:8000";
  // Strip trailing slash to avoid double-slash in URL
  serverUrl = serverUrl.replace(/\/+$/, "");

  const token = (cfg.authToken as string) ?? "";
  const agentId = "tabitha";

  // Use AbortController for request timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Agent-Id": agentId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => resp.statusText);
      return JSON.stringify({ error: true, status: resp.status, detail });
    }

    // Parse the JSON response and extract meaningful content
    const json = await resp.json();
    if (json.success && json.data) {
      // Extract text from MCP content array if present
      const content = json.data.content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text);
        if (texts.length > 0) {
          return texts.join("\n");
        }
      }
      // Fallback: stringify the data
      return JSON.stringify(json.data);
    }
    if (json.error) {
      return JSON.stringify({ error: true, detail: json.error });
    }
    return JSON.stringify(json);
  } catch (err: any) {
    if (err.name === "AbortError") {
      return JSON.stringify({ error: true, detail: `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms` });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Wrap a string result in the MCP content format OpenClaw expects. */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── Plugin entry point ───────────────────────────────────────────────────────
// Named export for OpenClaw plugin loader (expects `register` or `activate`)
export function register(api: PluginApi) {
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

  // Register security/provenance hooks
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  registerSecurityHooks(
    api,
    api.logger,
    {
      verbose: true,
      taintPolicy: (cfg.taintPolicy as any) ?? undefined,
      toolOverrides: (cfg.toolOverrides as any) ?? undefined,
      approvalTtlSeconds: (cfg.approvalTtlSeconds as number) ?? undefined,
      maxIterations: (cfg.maxIterations as number) ?? undefined,
    },
  );
};
