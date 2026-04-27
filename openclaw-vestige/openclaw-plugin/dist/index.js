"use strict";
/**
 * OpenClaw Vestige Plugin
 *
 * Registers cognitive memory tools backed by the Vestige HTTP bridge server.
 * Each tool maps to a FastAPI endpoint which in turn calls vestige-mcp over stdio.
 *
 * Also registers before_prompt_build and llm_output hooks for automatic
 * memory retrieval and ingestion via a local DeBERTa NLI zero-shot classifier.
 *
 * Migrated from before_llm_call/after_llm_call (removed from openclaw
 * mainline as part of Vincent's split hook model). The mutating prompt
 * surface is now `before_prompt_build` (used for memory retrieval +
 * injection via prependContext); the post-call observation surface is
 * `llm_output` (used for saliency-gated ingestion).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
const typebox_1 = require("@sinclair/typebox");
const before_prompt_build_js_1 = require("./hooks/before-prompt-build.js");
const llm_output_js_1 = require("./hooks/llm-output.js");
/** Default request timeout in milliseconds (30s). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Longer timeout for expensive operations (dream, consolidate). */
const LONG_TIMEOUT_MS = 180_000;
/** POST JSON to the Vestige bridge and return parsed response data. */
async function vestigeCall(api, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const cfg = (api.pluginConfig ?? {});
    let serverUrl = cfg.serverUrl ?? "http://vestige.internal:8000";
    serverUrl = serverUrl.replace(/\/+$/, "");
    const token = cfg.authToken ?? "";
    // agentId is set per-request via hook ctx; default for tool calls
    const agentId = cfg.agentId ?? "default";
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
            return JSON.stringify({ error: true, detail: `Request to ${path} timed out after ${timeoutMs}ms` });
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
    // Extract config once at registration time
    const cfg = (api.pluginConfig ?? {});
    let serverUrl = cfg.serverUrl ?? "http://vestige.internal:8000";
    serverUrl = serverUrl.replace(/\/+$/, "");
    const token = cfg.authToken ?? "";
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
    // ── v2.0 Tools ─────────────────────────────────────────────────────────
    api.registerTool({
        name: "vestige_dream",
        description: "Replay recent memories to discover connections, generate cross-domain insights, " +
            "and strengthen/decay memories via FSRS-6 spaced repetition. " +
            "Analogous to sleep consolidation — run nightly for best results.",
        parameters: typebox_1.Type.Object({
            memory_count: typebox_1.Type.Optional(typebox_1.Type.Integer({ description: "Number of recent memories to replay (default: 50, max: 500)", minimum: 1, maximum: 500 })),
        }),
        async execute(_id, params) {
            return textResult(await vestigeCall(api, "/dream", { memory_count: params.memory_count ?? 50 }, LONG_TIMEOUT_MS));
        },
    });
    api.registerTool({
        name: "vestige_consolidate",
        description: "Run a full FSRS-6 memory maintenance cycle: apply retention decay, update embeddings, " +
            "and perform garbage collection on the memory graph.",
        parameters: typebox_1.Type.Object({}),
        async execute(_id, _params) {
            return textResult(await vestigeCall(api, "/consolidate", {}, LONG_TIMEOUT_MS));
        },
    });
    api.registerTool({
        name: "vestige_backup",
        description: "Trigger a SQLite backup of the Vestige database (VACUUM INTO). " +
            "Run when vestige_session_context reports needsBackup: true.",
        parameters: typebox_1.Type.Object({}),
        async execute(_id, _params) {
            return textResult(await vestigeCall(api, "/backup", {}, LONG_TIMEOUT_MS));
        },
    });
    api.registerTool({
        name: "vestige_session_context",
        description: "One-call session initialization — retrieves relevant memories, active intentions, " +
            "retention predictions, and system health in a single request. " +
            "Use at session start to prime context.",
        parameters: typebox_1.Type.Object({
            queries: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), { description: "Search queries to run (default: ['user preferences'])" })),
            token_budget: typebox_1.Type.Optional(typebox_1.Type.Integer({ description: "Max tokens for response (default: 1000)", minimum: 100, maximum: 10000 })),
            include_status: typebox_1.Type.Optional(typebox_1.Type.Boolean({ description: "Include system health info (default: true)" })),
            include_intentions: typebox_1.Type.Optional(typebox_1.Type.Boolean({ description: "Include triggered intentions (default: true)" })),
            include_predictions: typebox_1.Type.Optional(typebox_1.Type.Boolean({ description: "Include memory predictions (default: true)" })),
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
        description: "Explore the memory connection graph via spreading activation. " +
            "Supports three modes: 'chain' (shortest path between two memories), " +
            "'associations' (memories connected to a source), " +
            "'bridges' (memories that connect two distant clusters).",
        parameters: typebox_1.Type.Object({
            action: typebox_1.Type.Union([typebox_1.Type.Literal("chain"), typebox_1.Type.Literal("associations"), typebox_1.Type.Literal("bridges")], { description: "Exploration mode" }),
            from: typebox_1.Type.String({ description: "Source memory ID" }),
            to: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Target memory ID (required for chain/bridges)" })),
            limit: typebox_1.Type.Optional(typebox_1.Type.Integer({ description: "Maximum results (default: 10)", minimum: 1, maximum: 100 })),
        }),
        async execute(_id, params) {
            const body = {
                action: params.action,
                from: params.from,
                limit: params.limit ?? 10,
            };
            if (params.to)
                body.to = params.to;
            return textResult(await vestigeCall(api, "/explore_connections", body));
        },
    });
    api.registerTool({
        name: "vestige_predict",
        description: "Predict which memories are likely to be needed based on current context. " +
            "Returns memories ranked by predicted relevance to the active task.",
        parameters: typebox_1.Type.Object({
            current_file: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Current file path for context" })),
            current_topics: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), { description: "Current topics for context" })),
            codebase: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Current codebase name" })),
        }),
        async execute(_id, params) {
            const body = {};
            const context = {};
            if (params.current_file)
                context.current_file = params.current_file;
            if (params.current_topics)
                context.current_topics = params.current_topics;
            if (params.codebase)
                context.codebase = params.codebase;
            if (Object.keys(context).length > 0)
                body.context = context;
            return textResult(await vestigeCall(api, "/predict", body));
        },
    });
    api.registerTool({
        name: "vestige_importance_score",
        description: "Score content for importance using 4-channel analysis (novelty, relevance, emotional valence, utility). " +
            "Use to evaluate whether something is worth storing before ingesting.",
        parameters: typebox_1.Type.Object({
            content: typebox_1.Type.String({ description: "Content to score for importance" }),
            context_topics: typebox_1.Type.Optional(typebox_1.Type.Array(typebox_1.Type.String(), { description: "Topics for novelty detection" })),
            project: typebox_1.Type.Optional(typebox_1.Type.String({ description: "Project/codebase name for context" })),
        }),
        async execute(_id, params) {
            const body = { content: params.content };
            if (params.context_topics)
                body.context_topics = params.context_topics;
            if (params.project)
                body.project = params.project;
            return textResult(await vestigeCall(api, "/importance_score", body));
        },
    });
    // ── Hook-based saliency (automatic memory retrieval + ingestion) ─────
    //
    // These hooks remove the LLM from the memory decision loop:
    // - before_prompt_build: scores inbound messages, retrieves relevant
    //   memories, injects them via `prependContext` for the LLM to see this
    //   turn. Per-turn (not persisted in conversation history).
    // - llm_output: scores outbound exchanges, auto-ingests important ones.
    //
    // Uses local DeBERTa-v3-xsmall NLI zero-shot classifier — no external
    // API keys needed. Model downloaded lazily on first use (~22MB quantized).
    const hooksEnabled = cfg.hooksEnabled ?? false;
    const conceptLabels = cfg.conceptLabels ?? undefined;
    const saliencyThreshold = cfg.saliencyThreshold ?? undefined;
    if (hooksEnabled) {
        // Feature-detect: gracefully degrade if the host doesn't support these hooks.
        try {
            // Inbound: retrieve relevant memories before prompt is finalized
            api.on("before_prompt_build", (0, before_prompt_build_js_1.createBeforePromptBuildHandler)({
                vestigeServerUrl: serverUrl,
                vestigeAuthToken: token || undefined,
                conceptLabels,
                saliencyThreshold,
                maxMemories: cfg.maxMemories ?? 5,
                maxMemoryTokens: cfg.maxMemoryTokens ?? 1000,
                logger: api.logger,
            }), { priority: 10 });
            // Outbound: auto-ingest important exchanges from the model's output
            api.on("llm_output", (0, llm_output_js_1.createLlmOutputHandler)({
                vestigeServerUrl: serverUrl,
                vestigeAuthToken: token || undefined,
                conceptLabels,
                saliencyThreshold,
            }), { priority: 90 });
            api.logger.info("[vestige] Ambient memory hooks registered: before_prompt_build + llm_output (model: DeBERTa-v3-xsmall NLI, local)");
        }
        catch (err) {
            // Host doesn't support these hooks — fall back to tool-only mode
            api.logger.info("[vestige] Host lacks before_prompt_build/llm_output hooks — falling back to tool-only mode");
        }
    }
}
