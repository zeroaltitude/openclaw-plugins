/**
 * Security & Provenance Plugin — Hook Registration
 * 
 * Registers handlers on OpenClaw's extended security hooks to build
 * per-turn provenance graphs and enforce declarative security policies.
 */

import { ProvenanceStore } from "./provenance-graph.js";
import type { TurnProvenanceGraph } from "./provenance-graph.js";
import { buildPolicyConfig, evaluateWithApprovals, type PolicyMode, type ToolOverride } from "./policy-engine.js";
import { getToolTrust } from "./trust-levels.js";
import type { TrustLevel, TaintPolicyConfig } from "./trust-levels.js";
import { ApprovalStore } from "./approval-store.js";

// Types matching OpenClaw's hook system (from src/plugins/types.ts)
interface HookApi {
  registerHook(events: string | string[], handler: (...args: any[]) => any, opts?: { priority?: number; name?: string; description?: string }): void;
  on(hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }): void;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export interface SecurityPluginConfig {
  /** Per-tool overrides: { "gateway": { "local": "restrict" }, "read": { "*": "allow" } } */
  toolOverrides?: Record<string, ToolOverride>;
  /** Override default tool trust classifications */
  toolTrustOverrides?: Record<string, TrustLevel>;
  /** Max completed graphs to keep in memory */
  maxCompletedGraphs?: number;
  /** Whether to log policy evaluations */
  verbose?: boolean;
  /** Per-trust-level default policy modes */
  taintPolicy?: Partial<Record<TrustLevel, PolicyMode>>;
  /** Approval code TTL in seconds (default: 60) */
  approvalTtlSeconds?: number;
  /** Max agent loop iterations before blocking (default: 10) */
  maxIterations?: number;
}

/** Get a short session key for log prefixes */
function shortKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length > 1) return parts[parts.length - 1].slice(0, 16);
  return sessionKey.slice(-8);
}

/**
 * Register the security/provenance hooks.
 */
export function registerSecurityHooks(
  api: HookApi,
  logger: { info(...args: any[]): void; warn(...args: any[]): void; debug?(...args: any[]): void },
  config?: SecurityPluginConfig,
): { store: ProvenanceStore; approvalStore: ApprovalStore } {
  const store = new ProvenanceStore(config?.maxCompletedGraphs ?? 100);
  const approvalTtlMs = (config?.approvalTtlSeconds ?? 60) * 1000;
  const approvalStore = new ApprovalStore(approvalTtlMs);
  const toolTrustOverrides = config?.toolTrustOverrides;
  const verbose = config?.verbose ?? false;

  // Build the unified policy config
  const policyConfig = buildPolicyConfig(
    config?.taintPolicy as any,
    config?.toolOverrides,
    config?.maxIterations,
  );

  // Log policy config at startup
  logger.info(`[provenance] Policy config loaded:`);
  logger.info(`[provenance]   Taint policy: ${JSON.stringify(policyConfig.taintPolicy)}`);
  logger.info(`[provenance]   Tool overrides: ${Object.keys(policyConfig.toolOverrides).length} tools configured`);
  logger.info(`[provenance]   Max iterations: ${policyConfig.maxIterations}`);

  // Track last LLM node ID per session for edge building
  const lastLlmNodeBySession = new Map<string, string>();

  // Track currently blocked tools per session for execution-layer enforcement
  const blockedToolsBySession = new Map<string, Set<string>>();

  // --- context_assembled ---
  api.on("context_assembled", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.startTurn(sessionKey);
    graph.recordContextAssembled(event.systemPrompt ?? "", event.messageCount ?? 0);

    const sk = shortKey(sessionKey);
    logger.info(`[provenance:${sk}] ── Turn Start ──`);
    logger.info(`[provenance:${sk}]   Messages: ${event.messageCount ?? 0} | System prompt: ${(event.systemPrompt ?? "").length} chars`);
  });

  // --- before_llm_call ---
  api.on("before_llm_call", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;

    // Record the LLM call
    const llmNodeId = graph.recordLlmCall(event.iteration ?? 0, event.tools?.length ?? 0);
    lastLlmNodeBySession.set(sessionKey, llmNodeId);

    const sk = shortKey(sessionKey);

    // Process .approve commands from the last user message
    const messages = event.messages ?? [];
    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
    if (lastUserMsg) {
      const content = typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")
          : "";
      const trimmed = content.trim();
      if (verbose && trimmed.includes(".approve")) {
        logger.info(`[provenance:${sk}] 🔍 Approve attempt detected. Raw content: "${trimmed.slice(0, 100)}"`);
      }
      const approveMatch = trimmed.match(/\.approve\s+(\S+)\s+([0-9a-f]{8})(?:\s+(\d+))?/i);
      if (approveMatch) {
        const target = approveMatch[1].toLowerCase();
        const code = approveMatch[2].toLowerCase();
        const durationStr = approveMatch[3];
        const durationMinutes = durationStr ? parseInt(durationStr, 10) : null;
        const result = approvalStore.approveWithCode(sessionKey, target, code, durationMinutes);
        if (result.ok) {
          const durDesc = durationMinutes != null ? `${durationMinutes} minutes` : "this turn only";
          logger.info(`[provenance:${sk}] ✅ Approved with valid code: ${result.approved.join(", ")} (duration: ${durDesc})`);
        } else {
          logger.warn(`[provenance:${sk}] ❌ Approval failed: ${result.reason}`);
        }
      }
    }

    // Evaluate policy
    const currentTools: Array<{ name: string }> = event.tools ?? [];
    const currentToolNames = currentTools.map((t: any) => t.name);
    const result = evaluateWithApprovals(graph, currentToolNames, policyConfig, approvalStore, sessionKey);

    if (result.mode === "allow") {
      logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
      logger.info(`[provenance:${sk}]   Taint: ${graph.maxTaint} | Mode: allow | Tools: ${currentToolNames.length}`);
      return undefined;
    }

    if (result.block) {
      logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
      logger.warn(`[provenance:${sk}]   Turn BLOCKED: ${result.blockReason}`);
      return { block: true, blockReason: result.blockReason };
    }

    // Log confirm-mode pending confirmations with approval code
    if (result.pendingConfirmations.length > 0) {
      const pendingNames = result.pendingConfirmations.map(p => p.toolName);

      // Reuse existing valid code if one exists
      const existingCode = approvalStore.getCurrentCode(sessionKey);
      const existingTtl = approvalStore.getCodeTtlSeconds(sessionKey);
      let code: string;
      let ttl: number;
      if (existingCode && existingTtl > 5) {
        code = existingCode;
        ttl = existingTtl;
      } else {
        code = approvalStore.addPendingBatch(
          result.pendingConfirmations.map(pc => ({
            sessionKey,
            toolName: pc.toolName,
            taintLevel: graph.maxTaint,
            reason: pc.reason,
            requestedAt: Date.now(),
          }))
        );
        ttl = approvalStore.getCodeTtlSeconds(sessionKey);
      }

      logger.warn(`[provenance:${sk}] ⚠️ SECURITY: Tools restricted due to ${graph.maxTaint} content in context.`);
      logger.warn(`[provenance:${sk}]   Restricted: ${pendingNames.join(", ")}`);
      logger.warn(`[provenance:${sk}]   Approval code: ${code} (expires in ${ttl}s)`);
      logger.warn(`[provenance:${sk}]   Approve with: .approve all ${code}  OR  .approve <tool> ${code}`);
    }

    const removedTools = Array.from(result.toolRemovals);
    const removedStr = removedTools.length > 0 ? removedTools.join(", ") : "(none)";

    logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
    logger.info(`[provenance:${sk}]   Taint: ${graph.maxTaint} | Mode: ${result.mode} | Tools: ${currentToolNames.length - removedTools.length}/${currentToolNames.length} | Removed: ${removedStr}`);

    // Update the execution-layer blocked set and filter tools
    if (result.toolRemovals.size > 0) {
      blockedToolsBySession.set(sessionKey, new Set(result.toolRemovals));

      // Case-insensitive filtering
      const removalsLower = new Set(Array.from(result.toolRemovals).map(t => t.toLowerCase()));
      const allowedTools = currentTools.filter((t: any) => !removalsLower.has(t.name.toLowerCase()));

      // Record policy decisions in graph
      for (const toolName of result.toolRemovals) {
        graph.recordBlockedTool(toolName, "policy", event.iteration ?? 0);
      }
      return { tools: allowedTools };
    } else {
      blockedToolsBySession.delete(sessionKey);
    }

    return undefined;
  }, { priority: 100 });

  // --- before_tool_call --- (EXECUTION-LAYER ENFORCEMENT)
  api.on("before_tool_call", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const blocked = blockedToolsBySession.get(sessionKey);
    if (!blocked || blocked.size === 0) return undefined;

    const toolName = event.toolName;
    const toolNameLower = toolName.toLowerCase();
    const isBlocked = Array.from(blocked).some(b => b.toLowerCase() === toolNameLower);
    if (isBlocked) {
      const sk = shortKey(sessionKey);
      const code = approvalStore.getCurrentCode(sessionKey);
      const ttl = approvalStore.getCodeTtlSeconds(sessionKey);
      const blockedList = Array.from(blocked).join(", ");
      const perToolExamples = Array.from(blocked).map(t => `.approve ${t} ${code} [minutes]`).join("\n  ");
      const codeStr = code && ttl > 0
        ? `\nBlocked tools: ${blockedList}\nApproval code: ${code} (expires in ${ttl}s)\nApprove all:  .approve all ${code} [minutes]\nApprove one:\n  ${perToolExamples}`
        : "\nA new approval code will be issued on the next turn.";
      logger.warn(`[provenance:${sk}] 🛑 BLOCKED at execution layer: ${toolName}`);
      return {
        block: true,
        blockReason: `Tool '${toolName}' is blocked by security policy. Context contains tainted content.${codeStr}`,
      };
    }
    return undefined;
  }, { priority: 100 });

  // --- after_llm_call ---
  api.on("after_llm_call", (event: any, ctx: AgentContext) => {
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
  api.on("loop_iteration_start", (event: any, ctx: AgentContext) => {
    if (verbose) {
      logger.info(`[provenance] Iteration ${event.iteration} start (${event.messageCount} messages)`);
    }
  });

  // --- loop_iteration_end ---
  api.on("loop_iteration_end", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;
    graph.recordIterationEnd(event.iteration ?? 0, event.toolCallsMade ?? 0, event.willContinue ?? false);

    const sk = shortKey(sessionKey);
    logger.info(`[provenance:${sk}] ── Iteration ${event.iteration ?? 0} End ──`);
    logger.info(`[provenance:${sk}]   Tool calls made: ${event.toolCallsMade ?? 0} | Will continue: ${event.willContinue ?? false}`);
  });

  // --- before_response_emit ---
  api.on("before_response_emit", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const graph = store.getActive(sessionKey);
    if (!graph) return;

    graph.recordOutput(event.content?.length ?? 0);

    // Clear turn-scoped approvals
    approvalStore.clearTurnScoped(sessionKey);

    // Seal the graph
    const summary = store.completeTurn(sessionKey);
    if (!summary) return;

    const sk = shortKey(sessionKey);

    logger.info(`[provenance:${sk}] ── Turn Complete ──`);
    logger.info(`[provenance:${sk}]   Final taint: ${summary.maxTaint}`);
    logger.info(`[provenance:${sk}]   External sources: ${summary.externalSources.length > 0 ? summary.externalSources.join(", ") : "(none)"}`);
    logger.info(`[provenance:${sk}]   Tools used: ${summary.toolsUsed.length > 0 ? summary.toolsUsed.join(", ") : "(none)"}`);
    logger.info(`[provenance:${sk}]   Tools blocked: ${summary.toolsBlocked.length > 0 ? summary.toolsBlocked.join(", ") : "(none)"}`);
    logger.info(`[provenance:${sk}]   Iterations: ${summary.iterationCount} | Nodes: ${summary.nodeCount} | Edges: ${summary.edgeCount}`);

    // Clear blocked tools for this session
    blockedToolsBySession.delete(sessionKey);
  });

  return { store, approvalStore };
}
