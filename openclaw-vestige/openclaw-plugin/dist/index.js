"use strict";
/**
 * OpenClaw Vestige Plugin
 *
 * Registers cognitive memory tools backed by the Vestige HTTP bridge server.
 * Each tool maps to a FastAPI endpoint which in turn calls vestige-mcp over stdio.
 *
 * Also registers before_llm_call and after_llm_call hooks for automatic
 * memory retrieval and ingestion via a local DeBERTa NLI zero-shot classifier.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
const typebox_1 = require("@sinclair/typebox");
const before_llm_call_js_1 = require("./hooks/before-llm-call.js");
const after_llm_call_js_1 = require("./hooks/after-llm-call.js");
/** Default request timeout in milliseconds (30s). */
const REQUEST_TIMEOUT_MS = 30_000;
/** POST JSON to the Vestige bridge and return parsed response data. */
async function vestigeCall(api, path, body) {
    const cfg = (api.pluginConfig ?? {});
    let serverUrl = cfg.serverUrl ?? "http://vestige.internal:8000";
    serverUrl = serverUrl.replace(/\/+$/, "");
    const token = cfg.authToken ?? "";
    // agentId is set per-request via hook ctx; default for tool calls
    const agentId = cfg.agentId ?? "default";
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
    // ── Hook-based saliency (automatic memory retrieval + ingestion) ─────
    //
    // These hooks remove the LLM from the memory decision loop:
    // - before_llm_call: scores inbound messages, retrieves relevant memories
    // - after_llm_call: scores outbound exchanges, auto-ingests important ones
    //
    // Uses local DeBERTa-v3-xsmall NLI zero-shot classifier — no external
    // API keys needed. Model downloaded lazily on first use (~22MB quantized).
    const hooksEnabled = cfg.hooksEnabled ?? false;
    const conceptLabels = cfg.conceptLabels ?? undefined;
    const saliencyThreshold = cfg.saliencyThreshold ?? undefined;
    if (hooksEnabled) {
        // Feature-detect: gracefully degrade if the host doesn't support these hooks.
        try {
            // Inbound: retrieve relevant memories before LLM call
            api.on("before_llm_call", (0, before_llm_call_js_1.createBeforeLlmCallHandler)({
                vestigeServerUrl: serverUrl,
                vestigeAuthToken: token || undefined,
                conceptLabels,
                saliencyThreshold,
                maxMemories: cfg.maxMemories ?? 5,
                maxMemoryTokens: cfg.maxMemoryTokens ?? 1000,
                firstIterationOnly: true,
                logger: api.logger,
            }), { priority: 10 });
            // Outbound: auto-ingest important exchanges after LLM call
            api.on("after_llm_call", (0, after_llm_call_js_1.createAfterLlmCallHandler)({
                vestigeServerUrl: serverUrl,
                vestigeAuthToken: token || undefined,
                conceptLabels,
                saliencyThreshold,
            }), { priority: 90 });
            api.logger.info("[vestige] Ambient memory hooks registered (model: DeBERTa-v3-xsmall NLI, local)");
        }
        catch (err) {
            // Host doesn't support these hooks — fall back to tool-only mode
            api.logger.info("[vestige] Host lacks before_llm_call/after_llm_call hooks — falling back to tool-only mode");
        }
    }
}
