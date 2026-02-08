/**
 * Security & Provenance Plugin — Hook Registration
 * 
 * Registers handlers on OpenClaw's extended security hooks to build
 * per-turn provenance graphs and enforce declarative security policies.
 */

import { ProvenanceStore } from "./provenance-graph.js";
import type { TurnProvenanceGraph } from "./provenance-graph.js";
import { evaluatePolicies, getToolRemovals, shouldBlockTurn, evaluateTaintPolicy, DEFAULT_POLICIES, type SecurityPolicy } from "./policy-engine.js";
import { getToolTrust } from "./trust-levels.js";
import type { TrustLevel, TaintPolicyConfig } from "./trust-levels.js";

// Types matching OpenClaw's hook system (from src/plugins/types.ts)
// We define them here to avoid a hard dependency on the OpenClaw source.
interface HookApi {
  registerHook(events: string | string[], handler: (...args: any[]) => any, opts?: { priority?: number }): void;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export interface SecurityPluginConfig {
  /** Custom policies (merged with defaults) */
  policies?: SecurityPolicy[];
  /** Override default tool trust classifications */
  toolTrustOverrides?: Record<string, TrustLevel>;
  /** Max completed graphs to keep in memory */
  maxCompletedGraphs?: number;
  /** Whether to log policy evaluations */
  verbose?: boolean;
  /** Per-trust-level policy modes */
  taintPolicy?: TaintPolicyConfig;
}

/** Get a short session key for log prefixes */
function shortKey(sessionKey: string): string {
  // Use last 8 chars, or the label portion if it contains a colon
  const parts = sessionKey.split(":");
  if (parts.length > 1) return parts[parts.length - 1].slice(0, 16);
  return sessionKey.slice(-8);
}

/**
 * Register the security/provenance hooks.
 * Call this from the main plugin setup function with the plugin API.
 */
export function registerSecurityHooks(
  api: HookApi,
  logger: { info(...args: any[]): void; warn(...args: any[]): void; debug?(...args: any[]): void },
  config?: SecurityPluginConfig,
): { store: ProvenanceStore } {
  const store = new ProvenanceStore(config?.maxCompletedGraphs ?? 100);
  const policies = [...DEFAULT_POLICIES, ...(config?.policies ?? [])];
  const toolTrustOverrides = config?.toolTrustOverrides;
  const verbose = config?.verbose ?? false;
  const taintPolicyConfig = config?.taintPolicy;

  // Track last LLM node ID per session for edge building
  const lastLlmNodeBySession = new Map<string, string>();

  // --- context_assembled ---
  api.registerHook("context_assembled", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.startTurn(sessionKey);
    graph.recordContextAssembled(event.systemPrompt ?? "", event.messageCount ?? 0);

    const sk = shortKey(sessionKey);
    logger.info(`[provenance:${sk}] ── Turn Start ──`);
    logger.info(`[provenance:${sk}]   Messages: ${event.messageCount ?? 0} | System prompt: ${(event.systemPrompt ?? "").length} chars`);
  });

  // --- before_llm_call ---
  api.registerHook("before_llm_call", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;

    // Record the LLM call
    const llmNodeId = graph.recordLlmCall(event.iteration ?? 0, event.tools?.length ?? 0);
    lastLlmNodeBySession.set(sessionKey, llmNodeId);

    const sk = shortKey(sessionKey);
    const summary = graph.summary();

    // Evaluate taint policy first
    const taintResult = evaluateTaintPolicy(graph, taintPolicyConfig);

    if (taintResult.mode === "allow") {
      logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
      logger.info(`[provenance:${sk}]   Accumulated taint: ${graph.maxTaint} (policy: allow — skipping restrictions)`);
      logger.info(`[provenance:${sk}]   Tools available: ${event.tools?.length ?? 0} | Tools removed by policy: (none)`);
      logger.info(`[provenance:${sk}]   Graph: ${summary.nodeCount} nodes, ${summary.edgeCount} edges`);
      return undefined;
    }

    if (taintResult.mode === "deny") {
      const reason = `Turn blocked by taint policy: ${taintResult.level} content is denied`;
      logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
      logger.info(`[provenance:${sk}]   Accumulated taint: ${graph.maxTaint} (policy: deny — BLOCKED)`);
      logger.warn(`[provenance:${sk}]   Turn BLOCKED: ${reason}`);
      return { block: true, blockReason: reason };
    }

    // "restrict" mode — evaluate policies normally
    const evaluations = evaluatePolicies(policies, graph);
    const toolRemovals = getToolRemovals(evaluations);
    const blockCheck = shouldBlockTurn(evaluations);

    if (blockCheck.block) {
      logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
      logger.info(`[provenance:${sk}]   Accumulated taint: ${graph.maxTaint}`);
      logger.warn(`[provenance:${sk}]   Turn BLOCKED: ${blockCheck.reason}`);
      return { block: true, blockReason: blockCheck.reason };
    }

    const currentTools: Array<{ name: string }> = event.tools ?? [];
    const removedTools = currentTools.filter((t: any) => toolRemovals.has(t.name)).map((t: any) => t.name);
    // Find which policies caused each removal
    const removedWithPolicies = removedTools.map((toolName: string) => {
      const matchingPolicy = evaluations.find(e => e.matched && (e.action?.removeTools?.includes(toolName) || e.action?.blockTools?.includes(toolName)));
      return toolName;
    });
    const policyNames = removedTools.map((toolName: string) => {
      const matchingPolicy = evaluations.find(e => e.matched && (e.action?.removeTools?.includes(toolName) || e.action?.blockTools?.includes(toolName)));
      return matchingPolicy?.policy.name ?? "policy";
    });

    const removedStr = removedTools.length > 0
      ? `${removedTools.join(", ")} (${[...new Set(policyNames)].join(", ")})`
      : "(none)";

    logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
    logger.info(`[provenance:${sk}]   Accumulated taint: ${graph.maxTaint}`);
    logger.info(`[provenance:${sk}]   Tools available: ${currentTools.length - removedTools.length} | Tools removed by policy: ${removedStr}`);
    logger.info(`[provenance:${sk}]   Graph: ${summary.nodeCount} nodes, ${summary.edgeCount} edges`);

    if (toolRemovals.size > 0) {
      const allowedTools = currentTools.filter((t: any) => !toolRemovals.has(t.name));
      // Record policy decisions
      for (const toolName of toolRemovals) {
        const matchingPolicy = evaluations.find(e => e.matched && (e.action?.removeTools?.includes(toolName) || e.action?.blockTools?.includes(toolName)));
        graph.recordBlockedTool(toolName, matchingPolicy?.policy.name ?? "policy", event.iteration ?? 0);
      }
      return { tools: allowedTools };
    }

    return undefined;
  }, { priority: 100 }); // High priority — security runs first

  // --- after_llm_call ---
  api.registerHook("after_llm_call", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;

    const llmNodeId = lastLlmNodeBySession.get(sessionKey);
    const toolCalls: Array<{ name: string }> = event.toolCalls ?? [];
    
    for (const tc of toolCalls) {
      graph.recordToolCall(tc.name, event.iteration ?? 0, llmNodeId, toolTrustOverrides);
    }

    const sk = shortKey(sessionKey);
    const toolDescriptions = toolCalls.map((tc: any) => {
      const trust = getToolTrust(tc.name, toolTrustOverrides);
      return `${tc.name}(${trust})`;
    });
    logger.info(`[provenance:${sk}] ── LLM Response (iteration ${event.iteration ?? 0}) ──`);
    logger.info(`[provenance:${sk}]   Tool calls: ${toolDescriptions.length > 0 ? toolDescriptions.join(", ") : "(none)"}`);
    logger.info(`[provenance:${sk}]   Taint after: ${graph.maxTaint}`);
  });

  // --- loop_iteration_start ---
  api.registerHook("loop_iteration_start", (event: any, ctx: AgentContext) => {
    // Currently just observational — graph tracks iteration via recordLlmCall
    if (verbose) {
      logger.info(`[provenance] Iteration ${event.iteration} start (${event.messageCount} messages)`);
    }
  });

  // --- loop_iteration_end ---
  api.registerHook("loop_iteration_end", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;
    graph.recordIterationEnd(event.iteration ?? 0, event.toolCallsMade ?? 0, event.willContinue ?? false);

    const sk = shortKey(sessionKey);
    logger.info(`[provenance:${sk}] ── Iteration ${event.iteration ?? 0} End ──`);
    logger.info(`[provenance:${sk}]   Tool calls made: ${event.toolCallsMade ?? 0} | Will continue: ${event.willContinue ?? false}`);
  });

  // --- before_response_emit ---
  api.registerHook("before_response_emit", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;

    graph.recordOutput(event.content?.length ?? 0);
    const summary = store.completeTurn(sessionKey);
    
    if (summary) {
      const sk = shortKey(sessionKey);
      logger.info(`[provenance:${sk}] ── Turn Complete ──`);
      logger.info(`[provenance:${sk}]   Final taint: ${summary.maxTaint}`);
      logger.info(`[provenance:${sk}]   External sources: ${summary.externalSources.length > 0 ? summary.externalSources.join(", ") : "(none)"}`);
      logger.info(`[provenance:${sk}]   Tools used: ${summary.toolsUsed.length > 0 ? summary.toolsUsed.join(", ") : "(none)"}`);
      logger.info(`[provenance:${sk}]   Tools blocked: ${summary.toolsBlocked.length > 0 ? summary.toolsBlocked.join(", ") : "(none)"}`);
      logger.info(`[provenance:${sk}]   Iterations: ${summary.iterationCount} | Nodes: ${summary.nodeCount} | Edges: ${summary.edgeCount}`);
      // Full graph dump — get from completed graphs
      const completed = store.getCompleted(1);
      const lastGraph = completed[completed.length - 1];
      if (lastGraph) {
        logger.info(`[provenance:${sk}]   Graph: ${JSON.stringify(lastGraph.toJSON())}`);
      }
    }

    return undefined;
  });

  return { store };
}
