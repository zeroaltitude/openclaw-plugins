/**
 * OpenClaw Vestige Plugin
 *
 * Registers cognitive memory tools backed by the Vestige HTTP bridge server.
 * Each tool maps to a FastAPI endpoint which in turn calls vestige-mcp over stdio.
 *
 * Also registers before_llm_call and after_llm_call hooks for automatic
 * memory retrieval and ingestion via a local DeBERTa NLI zero-shot classifier.
 */

import { Type } from "@sinclair/typebox";
import { createBeforeLlmCallHandler } from "./hooks/before-llm-call.js";
import { createAfterLlmCallHandler } from "./hooks/after-llm-call.js";

// The OpenClaw plugin API type (provided at runtime)
interface PluginApi {
  registerTool(def: {
    name: string;
    description: string;
    parameters: any;
    execute: (id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }): void;
  on(hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }): void;
  pluginConfig: Record<string, unknown> | undefined;
  config: Record<string, unknown>;
  logger: { info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
}

/** Default request timeout in milliseconds (30s). */
const REQUEST_TIMEOUT_MS = 30_000;

/** Longer timeout for expensive operations (dream, consolidate). */
const LONG_TIMEOUT_MS = 180_000;

/** POST JSON to the Vestige bridge and return parsed response data. */
async function vestigeCall(
  api: PluginApi,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string> {
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  let serverUrl = (cfg.serverUrl as string) ?? "http://vestige.internal:8000";
  serverUrl = serverUrl.replace(/\/+$/, "");

  const token = (cfg.authToken as string) ?? "";
  // agentId is set per-request via hook ctx; default for tool calls
  const agentId = (cfg.agentId as string) ?? "default";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

    const json = await resp.json();
    if (json.success && json.data) {
      const content = json.data.content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((c: any) => c.type === "text" && c.text)
          .map((c: any) => c.text);
        if (texts.length > 0) {
          return texts.join("\n");
        }
      }
      return JSON.stringify(json.data);
    }
    if (json.error) {
      return JSON.stringify({ error: true, detail: json.error });
    }
    return JSON.stringify(json);
  } catch (err: any) {
    if (err.name === "AbortError") {
      return JSON.stringify({ error: true, detail: `Request to ${path} timed out after ${timeoutMs}ms` });
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
export function register(api: PluginApi) {
  // Extract config once at registration time
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
  let serverUrl = (cfg.serverUrl as string) ?? "http://vestige.internal:8000";
  serverUrl = serverUrl.replace(/\/+$/, "");
  const token = (cfg.authToken as string) ?? "";

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

  // ── v2.0 Tools ─────────────────────────────────────────────────────────

  api.registerTool({
    name: "vestige_dream",
    description:
      "Replay recent memories to discover connections, generate cross-domain insights, " +
      "and strengthen/decay memories via FSRS-6 spaced repetition. " +
      "Analogous to sleep consolidation — run nightly for best results.",
    parameters: Type.Object({
      memory_count: Type.Optional(
        Type.Integer({ description: "Number of recent memories to replay (default: 50, max: 500)", minimum: 1, maximum: 500 }),
      ),
    }),
    async execute(_id, params) {
      return textResult(await vestigeCall(api, "/dream", { memory_count: params.memory_count ?? 50 }, LONG_TIMEOUT_MS));
    },
  });

  api.registerTool({
    name: "vestige_consolidate",
    description:
      "Run a full FSRS-6 memory maintenance cycle: apply retention decay, update embeddings, " +
      "and perform garbage collection on the memory graph.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      return textResult(await vestigeCall(api, "/consolidate", {}, LONG_TIMEOUT_MS));
    },
  });

  api.registerTool({
    name: "vestige_backup",
    description:
      "Trigger a SQLite backup of the Vestige database (VACUUM INTO). " +
      "Run when vestige_session_context reports needsBackup: true.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      return textResult(await vestigeCall(api, "/backup", {}, LONG_TIMEOUT_MS));
    },
  });

  api.registerTool({
    name: "vestige_session_context",
    description:
      "One-call session initialization — retrieves relevant memories, active intentions, " +
      "retention predictions, and system health in a single request. " +
      "Use at session start to prime context.",
    parameters: Type.Object({
      queries: Type.Optional(
        Type.Array(Type.String(), { description: "Search queries to run (default: ['user preferences'])" }),
      ),
      token_budget: Type.Optional(
        Type.Integer({ description: "Max tokens for response (default: 1000)", minimum: 100, maximum: 10000 }),
      ),
      include_status: Type.Optional(Type.Boolean({ description: "Include system health info (default: true)" })),
      include_intentions: Type.Optional(Type.Boolean({ description: "Include triggered intentions (default: true)" })),
      include_predictions: Type.Optional(Type.Boolean({ description: "Include memory predictions (default: true)" })),
    }),
    async execute(_id, params) {
      return textResult(await vestigeCall(api, "/session_context", {
        queries: params.queries ?? ["user preferences"],
        token_budget: params.token_budget ?? 1000,
        include_status: params.include_status ?? true,
        include_intentions: params.include_intentions ?? true,
        include_predictions: params.include_predictions ?? true,
      }));
    },
  });

  api.registerTool({
    name: "vestige_explore_connections",
    description:
      "Explore the memory connection graph via spreading activation. " +
      "Supports three modes: 'chain' (shortest path between two memories), " +
      "'associations' (memories connected to a source), " +
      "'bridges' (memories that connect two distant clusters).",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("chain"), Type.Literal("associations"), Type.Literal("bridges")],
        { description: "Exploration mode" },
      ),
      from: Type.String({ description: "Source memory ID" }),
      to: Type.Optional(Type.String({ description: "Target memory ID (required for chain/bridges)" })),
      limit: Type.Optional(
        Type.Integer({ description: "Maximum results (default: 10)", minimum: 1, maximum: 100 }),
      ),
    }),
    async execute(_id, params) {
      const body: Record<string, unknown> = {
        action: params.action,
        from: params.from,
        limit: params.limit ?? 10,
      };
      if (params.to) body.to = params.to;
      return textResult(await vestigeCall(api, "/explore_connections", body));
    },
  });

  api.registerTool({
    name: "vestige_predict",
    description:
      "Predict which memories are likely to be needed based on current context. " +
      "Returns memories ranked by predicted relevance to the active task.",
    parameters: Type.Object({
      current_file: Type.Optional(Type.String({ description: "Current file path for context" })),
      current_topics: Type.Optional(
        Type.Array(Type.String(), { description: "Current topics for context" }),
      ),
      codebase: Type.Optional(Type.String({ description: "Current codebase name" })),
    }),
    async execute(_id, params) {
      const body: Record<string, unknown> = {};
      const context: Record<string, unknown> = {};
      if (params.current_file) context.current_file = params.current_file;
      if (params.current_topics) context.current_topics = params.current_topics;
      if (params.codebase) context.codebase = params.codebase;
      if (Object.keys(context).length > 0) body.context = context;
      return textResult(await vestigeCall(api, "/predict", body));
    },
  });

  api.registerTool({
    name: "vestige_importance_score",
    description:
      "Score content for importance using 4-channel analysis (novelty, relevance, emotional valence, utility). " +
      "Use to evaluate whether something is worth storing before ingesting.",
    parameters: Type.Object({
      content: Type.String({ description: "Content to score for importance" }),
      context_topics: Type.Optional(
        Type.Array(Type.String(), { description: "Topics for novelty detection" }),
      ),
      project: Type.Optional(Type.String({ description: "Project/codebase name for context" })),
    }),
    async execute(_id, params) {
      const body: Record<string, unknown> = { content: params.content };
      if (params.context_topics) body.context_topics = params.context_topics;
      if (params.project) body.project = params.project;
      return textResult(await vestigeCall(api, "/importance_score", body));
    },
  });

  // ── Hook-based saliency (automatic memory retrieval + ingestion) ─────
  //
  // These hooks remove the LLM from the memory decision loop:
  // - before_llm_call: scores inbound messages, retrieves relevant memories
  // - after_llm_call: scores outbound exchanges, auto-ingests important ones
  //
  // Uses local DeBERTa-v3-xsmall NLI zero-shot classifier — no external
  // API keys needed. Model downloaded lazily on first use (~22MB quantized).

  const hooksEnabled = (cfg.hooksEnabled as boolean) ?? false;
  const conceptLabels = (cfg.conceptLabels as string[] | undefined) ?? undefined;
  const saliencyThreshold = (cfg.saliencyThreshold as number | undefined) ?? undefined;

  if (hooksEnabled) {
    // Feature-detect: gracefully degrade if the host doesn't support these hooks.
    try {
      // Inbound: retrieve relevant memories before LLM call
      api.on(
        "before_llm_call",
        createBeforeLlmCallHandler({
          vestigeServerUrl: serverUrl,
          vestigeAuthToken: token || undefined,
          conceptLabels,
          saliencyThreshold,
          maxMemories: (cfg.maxMemories as number) ?? 5,
          maxMemoryTokens: (cfg.maxMemoryTokens as number) ?? 1000,
          firstIterationOnly: true,
          logger: api.logger,
        }),
        { priority: 10 },
      );

      // Outbound: auto-ingest important exchanges after LLM call
      api.on(
        "after_llm_call",
        createAfterLlmCallHandler({
          vestigeServerUrl: serverUrl,
          vestigeAuthToken: token || undefined,
          conceptLabels,
          saliencyThreshold,
        }),
        { priority: 90 },
      );

      api.logger.info("[vestige] Ambient memory hooks registered (model: DeBERTa-v3-xsmall NLI, local)");
    } catch (err) {
      // Host doesn't support these hooks — fall back to tool-only mode
      api.logger.info(
        "[vestige] Host lacks before_llm_call/after_llm_call hooks — falling back to tool-only mode",
      );
    }
  }
}
