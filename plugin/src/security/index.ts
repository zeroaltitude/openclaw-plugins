/**
 * Security & Provenance Plugin — Hook Registration
 * 
 * Registers handlers on OpenClaw's extended security hooks to build
 * per-turn provenance graphs and enforce declarative security policies.
 */

import { ProvenanceStore } from "./provenance-graph.js";
import type { TurnProvenanceGraph } from "./provenance-graph.js";
import { evaluatePolicies, getToolRemovals, shouldBlockTurn, evaluateTaintPolicy, evaluateTaintPolicyWithApprovals, DEFAULT_POLICIES, type SecurityPolicy } from "./policy-engine.js";
import { getToolTrust } from "./trust-levels.js";
import type { TrustLevel, TaintPolicyConfig } from "./trust-levels.js";
import { DEFAULT_TAINT_POLICY } from "./trust-levels.js";
import { ApprovalStore } from "./approval-store.js";

// Types matching OpenClaw's hook system (from src/plugins/types.ts)
// We define them here to avoid a hard dependency on the OpenClaw source.
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
  /** Discord channel/DM ID to send confirmation requests to */
  notifyTarget?: string;
  /** Approval code TTL in seconds (default: 60) */
  approvalTtlSeconds?: number;
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
): { store: ProvenanceStore; approvalStore: ApprovalStore } {
  const store = new ProvenanceStore(config?.maxCompletedGraphs ?? 100);
  const approvalTtlMs = (config?.approvalTtlSeconds ?? 60) * 1000;
  const approvalStore = new ApprovalStore(approvalTtlMs);
  const policies = [...DEFAULT_POLICIES, ...(config?.policies ?? [])];
  const toolTrustOverrides = config?.toolTrustOverrides;
  const verbose = config?.verbose ?? false;
  const taintPolicyConfig = config?.taintPolicy;
  const fullTaintConfig = { ...DEFAULT_TAINT_POLICY, ...taintPolicyConfig };

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
    const summary = graph.summary();

    // Process .approve commands from the last user message before policy evaluation
    // Format: .approve <all|tool> <code>
    // Code is time-limited and must match the pending approval code
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
      // Format: .approve <all|tool> <code> [minutes]
      // No minutes = this turn only. Number = approval lasts that many minutes.
      // Allow the command anywhere in the message (not just as the entire message)
      const approveMatch = trimmed.match(/\.approve\s+(\S+)\s+([0-9a-f]{8})(?:\s+(\d+))?/i);
      if (approveMatch) {
        const target = approveMatch[1].toLowerCase(); // "all" or tool name
        const code = approveMatch[2].toLowerCase();    // the approval code
        const durationStr = approveMatch[3];           // optional minutes
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

    // Use the unified policy evaluator that handles all modes including "confirm"
    const result = evaluateTaintPolicyWithApprovals(graph, fullTaintConfig, policies, approvalStore, sessionKey);

    if (result.mode === "allow") {
      logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
      logger.info(`[provenance:${sk}]   Accumulated taint: ${graph.maxTaint} (policy: allow — skipping restrictions)`);
      logger.info(`[provenance:${sk}]   Tools available: ${event.tools?.length ?? 0} | Tools removed by policy: (none)`);
      logger.info(`[provenance:${sk}]   Graph: ${summary.nodeCount} nodes, ${summary.edgeCount} edges`);
      return undefined;
    }

    if (result.block) {
      logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
      logger.info(`[provenance:${sk}]   Accumulated taint: ${graph.maxTaint} (policy: ${result.mode} — BLOCKED)`);
      logger.warn(`[provenance:${sk}]   Turn BLOCKED: ${result.blockReason}`);
      return { block: true, blockReason: result.blockReason };
    }

    const toolRemovals = result.toolRemovals;
    const currentTools: Array<{ name: string }> = event.tools ?? [];
    const removedTools = currentTools.filter((t: any) => toolRemovals.has(t.name)).map((t: any) => t.name);

    // Log confirm-mode pending confirmations with approval code
    if (result.mode === "confirm" && result.pendingConfirmations.length > 0) {
      const pendingNames = result.pendingConfirmations.map(p => p.toolName);

      // Reuse existing valid code if one exists, otherwise generate new
      const existingCode = approvalStore.getCurrentCode(sessionKey);
      const existingTtl = approvalStore.getCodeTtlSeconds(sessionKey);
      let code: string;
      let ttl: number;
      if (existingCode && existingTtl > 5) {
        // Reuse existing code — don't invalidate what the user might be typing
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

    const removedStr = removedTools.length > 0
      ? removedTools.join(", ")
      : "(none)";

    logger.info(`[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`);
    logger.info(`[provenance:${sk}]   Accumulated taint: ${graph.maxTaint} (policy: ${result.mode})`);
    logger.info(`[provenance:${sk}]   Tools available: ${currentTools.length - removedTools.length} | Tools removed by policy: ${removedStr}`);
    logger.info(`[provenance:${sk}]   Graph: ${summary.nodeCount} nodes, ${summary.edgeCount} edges`);

    // Update the execution-layer blocked set
    if (toolRemovals.size > 0) {
      blockedToolsBySession.set(sessionKey, new Set(toolRemovals));
      const allowedTools = currentTools.filter((t: any) => !toolRemovals.has(t.name));
      // Record policy decisions
      for (const toolName of toolRemovals) {
        graph.recordBlockedTool(toolName, "policy", event.iteration ?? 0);
      }
      return { tools: allowedTools };
    } else {
      // Clear blocked set if no removals
      blockedToolsBySession.delete(sessionKey);
    }

    return undefined;
  }, { priority: 100 }); // High priority — security runs first

  // --- before_tool_call --- (EXECUTION-LAYER ENFORCEMENT)
  // This is the critical enforcement point. Even if the LLM hallucinates a tool
  // call for a tool that was removed from its context by before_llm_call, this
  // hook blocks execution. Defense in depth.
  api.on("before_tool_call", (event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const blocked = blockedToolsBySession.get(sessionKey);
    if (!blocked || blocked.size === 0) return undefined;

    const toolName = event.toolName;
    if (blocked.has(toolName)) {
      const sk = shortKey(sessionKey);
      const code = approvalStore.getCurrentCode(sessionKey);
      const ttl = approvalStore.getCodeTtlSeconds(sessionKey);
      const blockedList = Array.from(blocked).join(", ");
      const perToolExamples = Array.from(blocked).map(t => `.approve ${t} ${code} [minutes]`).join("\n  ");
      const codeStr = code && ttl > 0
        ? `\nBlocked tools: ${blockedList}\nApproval code: ${code} (expires in ${ttl}s)\nApprove all:  .approve all ${code} [minutes]\nApprove one:\n  ${perToolExamples}`
        : "\nA new approval code will be issued on the next turn.";
      logger.warn(`[provenance:${sk}] 🛑 BLOCKED at execution layer: ${toolName} (removed by taint policy but LLM called it anyway)`);
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
    // Currently just observational — graph tracks iteration via recordLlmCall
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

    // Clean up blocked tools and turn-scoped approvals when turn completes
    blockedToolsBySession.delete(sessionKey);
    approvalStore.clearTurnScoped(sessionKey);

    return undefined;
  });

  // --- before_agent_start ---
  // Inject approval instructions into the system prompt when tools are pending confirmation
  api.on("before_agent_start", (_event: any, ctx: AgentContext) => {
    const sessionKey = ctx.sessionKey ?? "unknown";
    const pending = approvalStore.getPending(sessionKey);
    if (pending.length > 0) {
      const toolList = pending.map(p => p.toolName).join(", ");
      const reasons = [...new Set(pending.map(p => p.reason))].join("; ");
      const code = approvalStore.getCurrentCode(sessionKey);
      const ttl = approvalStore.getCodeTtlSeconds(sessionKey);
      return {
        prependContext: `⚠️ SECURITY: Tools restricted: ${toolList}\nApproval code: ${code} (expires in ${ttl}s)\nUser must send: .approve all ${code} [minutes]\nExamples: ".approve all ${code}" (this turn only) or ".approve all ${code} 30" (30 min)\nRestricted due to: ${reasons}\nDo NOT suggest alternative approval methods. Only .approve <all|tool> <code> [minutes] works.`,
      };
    }
    return undefined;
  });

  return { store, approvalStore };
}
