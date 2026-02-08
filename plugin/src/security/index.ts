/**
 * Security & Provenance Plugin — Hook Registration
 * 
 * Registers handlers on OpenClaw's extended security hooks to build
 * per-turn provenance graphs and enforce declarative security policies.
 */

import { ProvenanceStore } from "./provenance-graph.js";
import type { TurnProvenanceGraph } from "./provenance-graph.js";
import { evaluatePolicies, getToolRemovals, shouldBlockTurn, DEFAULT_POLICIES, type SecurityPolicy } from "./policy-engine.js";
import type { TrustLevel } from "./trust-levels.js";

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

  // Track last LLM node ID per session for edge building
  const lastLlmNodeBySession = new Map<string, string>();

  // --- context_assembled ---
  api.registerHook("context_assembled", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.startTurn(sessionKey);
    graph.recordContextAssembled(event.systemPrompt ?? "", event.messageCount ?? 0);
    if (verbose) {
      logger.info(`[provenance] Turn started for ${sessionKey}, ${event.messageCount} messages`);
    }
  });

  // --- before_llm_call ---
  api.registerHook("before_llm_call", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;

    // Record the LLM call
    const llmNodeId = graph.recordLlmCall(event.iteration ?? 0, event.tools?.length ?? 0);
    lastLlmNodeBySession.set(sessionKey, llmNodeId);

    // Evaluate policies against current graph state
    const evaluations = evaluatePolicies(policies, graph);
    const toolRemovals = getToolRemovals(evaluations);
    const blockCheck = shouldBlockTurn(evaluations);

    if (blockCheck.block) {
      if (verbose) logger.warn(`[provenance] Turn BLOCKED: ${blockCheck.reason}`);
      return { block: true, blockReason: blockCheck.reason };
    }

    if (toolRemovals.size > 0) {
      const currentTools: Array<{ name: string }> = event.tools ?? [];
      const allowedTools = currentTools.filter((t: any) => !toolRemovals.has(t.name));
      if (verbose) {
        const removed = currentTools.filter((t: any) => toolRemovals.has(t.name)).map((t: any) => t.name);
        logger.info(`[provenance] Tools removed by policy: ${removed.join(", ")}`);
      }
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
  });

  // --- before_response_emit ---
  api.registerHook("before_response_emit", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;

    graph.recordOutput(event.content?.length ?? 0);
    const summary = store.completeTurn(sessionKey);
    
    if (verbose && summary) {
      logger.info(`[provenance] Turn complete: taint=${summary.maxTaint}, tools=${summary.toolsUsed.join(",")}, blocked=${summary.toolsBlocked.join(",")}, iterations=${summary.iterationCount}`);
    }

    return undefined;
  });

  return { store };
}
