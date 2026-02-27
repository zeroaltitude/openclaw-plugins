"use strict";
/**
 * OpenClaw Vestige Plugin
 *
 * Registers cognitive memory tools backed by the Vestige HTTP bridge server.
 * Each tool maps to a FastAPI endpoint which in turn calls vestige-mcp over stdio.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
const typebox_1 = require("@sinclair/typebox");
/** Default request timeout in milliseconds (30s). */
const REQUEST_TIMEOUT_MS = 30_000;
/** POST JSON to the Vestige bridge and return parsed response data. */
async function vestigeCall(api, path, body) {
    const cfg = (api.pluginConfig ?? {});
    let serverUrl = cfg.serverUrl ?? "http://vestige.internal:8000";
    serverUrl = serverUrl.replace(/\/+$/, "");
    const token = cfg.authToken ?? "";
    const agentId = "tabitha";
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
        const json = await resp.json();
        if (json.success && json.data) {
            const content = json.data.content;
            if (Array.isArray(content)) {
                const texts = content
                    .filter((c) => c.type === "text" && c.text)
                    .map((c) => c.text);
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
    }
    catch (err) {
        if (err.name === "AbortError") {
            return JSON.stringify({ error: true, detail: `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms` });
        }
        throw err;
    }
    finally {
        clearTimeout(timeoutId);
    }
}
/** Wrap a string result in the MCP content format OpenClaw expects. */
function textResult(text) {
    return { content: [{ type: "text", text }] };
}
// ── Plugin entry point ───────────────────────────────────────────────────────
function register(api) {
    api.registerTool({
        name: "vestige_search",
        description: "Search cognitive memory. Supports keyword, semantic, and hybrid modes. " +
            "Returns memories ranked by relevance × retention strength.",
        parameters: typebox_1.Type.Object({
            query: typebox_1.Type.String({ description: "Search query text" }),
            mode: typebox_1.Type.Optional(typebox_1.Type.Union([typebox_1.Type.Literal("keyword"), typebox_1.Type.Literal("semantic"), typebox_1.Type.Literal("hybrid")], {
                description: "Search mode (default: hybrid)",
            })),
            limit: typebox_1.Type.Optional(typebox_1.Type.Integer({ description: "Max results (default: 10)", minimum: 1, maximum: 100 })),
            threshold: typebox_1.Type.Optional(typebox_1.Type.Number({ description: "Min relevance score 0-1" })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/search", params));
        },
    });
    api.registerTool({
        name: "vestige_ingest",
        description: "Store a memory directly without duplicate detection. Use vestige_smart_ingest for intelligent ingestion.",
        parameters: typebox_1.Type.Object({
            content: typebox_1.Type.String({ description: "Content to store" }),
            node_type: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Memory type: fact, concept, event, etc." })),
            tags: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), { description: "Tags for organization" })),
            context: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Optional context" })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/ingest", params));
        },
    });
    api.registerTool({
        name: "vestige_smart_ingest",
        description: "Intelligently ingest a memory with prediction error gating — automatically detects duplicates " +
            "and decides whether to CREATE, UPDATE, REINFORCE, or SUPERSEDE existing memories.",
        parameters: typebox_1.Type.Object({
            content: typebox_1.Type.String({ description: "Content to store" }),
            node_type: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Memory type: fact, concept, event, etc." })),
            tags: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), { description: "Tags" })),
            context: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Optional context" })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/smart_ingest", params));
        },
    });
    api.registerTool({
        name: "vestige_promote",
        description: "Mark a memory as helpful / correct — strengthens its retention and retrieval strength.",
        parameters: typebox_1.Type.Object({
            memory_id: typebox_1.Type.String({ description: "Memory ID to promote" }),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/promote", params));
        },
    });
    api.registerTool({
        name: "vestige_demote",
        description: "Mark a memory as wrong / unhelpful — weakens its retention strength.",
        parameters: typebox_1.Type.Object({
            memory_id: typebox_1.Type.String({ description: "Memory ID to demote" }),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/demote", params));
        },
    });
    // ── v2.0 Tools ───────────────────────────────────────────────────────────
    api.registerTool({
        name: "vestige_dream",
        description: "Trigger memory dreaming — replays recent memories to discover hidden connections, " +
            "synthesize insights, and strengthen important patterns. Returns insights, connections, and dream stats.",
        parameters: typebox_1.Type.Object({
            memory_count: typebox_1.Type.Optional(typebox_1.Type.Integer({
                description: "Number of recent memories to dream about (default: 50)",
                minimum: 1,
                maximum: 500,
            })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/dream", params));
        },
    });
    api.registerTool({
        name: "vestige_session_context",
        description: "One-call session initialization. Combines search, intentions, status, predictions, and " +
            "codebase context into a single token-budgeted response. Replaces 5 separate calls at session start.",
        parameters: typebox_1.Type.Object({
            queries: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), {
                description: "Search queries to run (default: [\"user preferences\"])",
            })),
            token_budget: typebox_1.Type.Optional(typebox_1.Type.Integer({
                description: "Max tokens for response (default: 1000)",
                minimum: 100,
                maximum: 10000,
            })),
            context: typebox_1.Type.Optional(typebox_1.Type.Object({
                codebase: typebox_1.Type.Optional(typebox_1.Type.String()),
                topics: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String())),
                file: typebox_1.Type.Optional(typebox_1.Type.String()),
            }, { description: "Current context for intention matching and predictions" })),
            include_status: typebox_1.Type.Optional(typebox_1.Type.Boolean({ description: "Include system health info (default: true)" })),
            include_intentions: typebox_1.Type.Optional(typebox_1.Type.Boolean({ description: "Include triggered intentions (default: true)" })),
            include_predictions: typebox_1.Type.Optional(typebox_1.Type.Boolean({ description: "Include memory predictions (default: true)" })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/session_context", params));
        },
    });
    api.registerTool({
        name: "vestige_explore_connections",
        description: "Graph exploration for memory connections. Actions: 'chain' (reasoning path between memories), " +
            "'associations' (find related via spreading activation), 'bridges' (find connecting memories between two nodes).",
        parameters: typebox_1.Type.Object({
            action: typebox_1.Type.Union([typebox_1.Type.Literal("chain"), typebox_1.Type.Literal("associations"), typebox_1.Type.Literal("bridges")], {
                description: "Type of exploration",
            }),
            from: typebox_1.Type.String({ description: "Source memory ID" }),
            to: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Target memory ID (required for chain/bridges)" })),
            limit: typebox_1.Type.Optional(typebox_1.Type.Integer({ description: "Maximum results (default: 10)", minimum: 1, maximum: 100 })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/explore_connections", params));
        },
    });
    api.registerTool({
        name: "vestige_predict",
        description: "Proactive memory prediction — predicts what memories you'll need next based on context, " +
            "recent activity, and learned patterns.",
        parameters: typebox_1.Type.Object({
            context: typebox_1.Type.Optional(typebox_1.Type.Object({
                current_file: typebox_1.Type.Optional(typebox_1.Type.String()),
                current_topics: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String())),
                codebase: typebox_1.Type.Optional(typebox_1.Type.String()),
            }, { description: "Current context for prediction" })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/predict", params));
        },
    });
    api.registerTool({
        name: "vestige_importance_score",
        description: "Score content for importance using multi-channel importance signals — novelty detection, " +
            "emotional valence, cross-reference density, and pattern disruption.",
        parameters: typebox_1.Type.Object({
            content: typebox_1.Type.String({ description: "Content to score for importance" }),
            context_topics: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), {
                description: "Topics for novelty detection context",
            })),
            project: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Project/codebase name for context" })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/importance_score", params));
        },
    });
    api.registerTool({
        name: "vestige_consolidate",
        description: "Run FSRS-6 memory consolidation cycle. Applies decay, generates embeddings, " +
            "and performs maintenance. Use when memories seem stale.",
        parameters: typebox_1.Type.Object({}),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/consolidate", params ?? {}));
        },
    });
}
