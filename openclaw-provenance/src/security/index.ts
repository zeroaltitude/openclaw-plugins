/**
 * Security & Provenance Plugin — Hook Registration
 *
 * Registers handlers on OpenClaw's extended security hooks to build
 * per-turn provenance graphs and enforce declarative security policies.
 *
 * Fail-open design: all hooks are wrapped in try/catch. On error, the
 * agent continues operating without taint tracking.
 */

import {
  ProvenanceStore,
  buildWatermarkReason,
} from "./provenance-graph.js";
import type { TurnProvenanceGraph } from "./provenance-graph.js";
import { WatermarkStore } from "./watermark-store.js";
import { BlockedWriteStore } from "./blocked-write-store.js";
import {
  buildPolicyConfig,
  evaluateWithApprovals,
  type PolicyMode,
  type ToolOverride,
} from "./policy-engine.js";
import {
  getToolTrust,
  buildToolOutputTaintMap,
  TRUST_ORDER,
} from "./trust-levels.js";
import type { TrustLevel } from "./trust-levels.js";
import { ApprovalStore } from "./approval-store.js";
import { isMemoryFile } from "./memory-file-detector.js";
import { basename } from "node:path";

// Types matching OpenClaw's hook system
interface HookApi {
  registerHook?(
    events: string | string[],
    handler: (...args: any[]) => any,
    opts?: { name?: string; description?: string },
  ): void;
  on(
    hookName: string,
    handler: (...args: any[]) => any,
    opts?: Record<string, unknown>,
  ): void;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
  senderId?: string | null;
  senderName?: string | null;
  senderIsOwner?: boolean;
  groupId?: string | null;
  spawnedBy?: string | null;
}

export interface SecurityPluginConfig {
  toolOverrides?: Record<string, ToolOverride>;
  toolTrustOverrides?: Record<string, TrustLevel>;
  toolOutputTaints?: Record<string, TrustLevel>;
  maxCompletedGraphs?: number;
  verbose?: boolean;
  taintPolicy?: Partial<Record<string, PolicyMode>>;
  maxIterations?: number;
  developerMode?: boolean;
  workspaceDir?: string;
  /** Additional sender IDs classified as trusted */
  trustedSenderIds?: string[];
}

/** Get a short session key for log prefixes */
function shortKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length > 1) return parts[parts.length - 1].slice(0, 16);
  return sessionKey.slice(-8);
}

/**
 * Classify initial trust level from sender/channel metadata.
 *
 * 1. No messageProvider (cron, heartbeat, system event) → trusted
 * 2. Sub-agent session (spawnedBy set) → trusted
 * 3. Owner (senderIsOwner=true) → trusted
 * 4. Trusted sender (senderId in trustedSenderIds) → trusted
 * 5. Known non-owner sender → external
 * 6. Unknown sender → untrusted
 */
function classifyInitialTrust(
  ctx: AgentContext,
  trustedSenderIds: Set<string>,
): TrustLevel {
  if (
    !ctx.messageProvider ||
    ctx.messageProvider === "heartbeat" ||
    ctx.messageProvider === "cron" ||
    ctx.messageProvider === "webchat"
  ) {
    return "trusted";
  }

  if (ctx.spawnedBy) {
    return "trusted";
  }

  if (ctx.senderIsOwner) {
    return "trusted";
  }

  if (ctx.senderId && trustedSenderIds.has(ctx.senderId)) {
    return "trusted";
  }

  if (ctx.senderId) {
    return "external";
  }

  return "untrusted";
}

/**
 * Check if the current session is an owner DM (for message tool exception).
 */
function isOwnerDm(ctx: AgentContext): boolean {
  return ctx.senderIsOwner === true && !ctx.groupId;
}

/**
 * Build a short human-readable reason for the current taint level.
 */
function buildTaintReason(
  graph: TurnProvenanceGraph,
  watermarkReason?: string,
): string {
  const nodes = graph.getAllNodes();
  const taintIdx = TRUST_ORDER.indexOf(graph.maxTaint);

  const inherited = nodes.find((n) => n.id === "inherited-taint");
  if (inherited && TRUST_ORDER.indexOf(inherited.trust) >= taintIdx) {
    return truncate(watermarkReason ?? "inherited from prev turn", 30);
  }

  const toolNodes = nodes.filter(
    (n) =>
      n.kind === "tool_call" && TRUST_ORDER.indexOf(n.trust) >= taintIdx,
  );
  if (toolNodes.length > 0) {
    const toolNames = toolNodes.map((n) => n.tool).filter(Boolean);
    return truncate(toolNames.join(", ") || "tool call", 30);
  }

  const histNode = nodes.find(
    (n) =>
      n.kind === "history" && TRUST_ORDER.indexOf(n.trust) >= taintIdx,
  );
  if (histNode) {
    const reason = (histNode.metadata?.reason as string) ?? "context classification";
    return truncate(reason, 30);
  }

  if (graph.maxTaint === "trusted") {
    return truncate("clean context", 30);
  }
  return truncate("unknown", 30);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Wrap a hook handler in try/catch for fail-open behavior.
 */
function failOpen<T extends (...args: any[]) => any>(
  hookName: string,
  logger: { error(...args: any[]): void },
  handler: T,
): T {
  return ((...args: any[]) => {
    try {
      return handler(...args);
    } catch (err) {
      logger.error(
        `[provenance] FAIL-OPEN: Error in ${hookName} hook — agent continues without taint tracking`,
        err,
      );
      return undefined;
    }
  }) as T;
}

/**
 * Register the security/provenance hooks.
 */
export function registerSecurityHooks(
  api: HookApi,
  logger: {
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  },
  config?: SecurityPluginConfig,
): { store: ProvenanceStore; approvalStore: ApprovalStore } {
  const store = new ProvenanceStore(config?.maxCompletedGraphs ?? 100);
  const approvalStore = new ApprovalStore();
  const toolOutputTaintOverrides =
    config?.toolOutputTaints ?? config?.toolTrustOverrides;
  const resolvedToolTaints = buildToolOutputTaintMap(toolOutputTaintOverrides);
  const verbose = config?.verbose ?? false;
  const developerMode = config?.developerMode ?? false;
  const workspaceDir = config?.workspaceDir ?? process.cwd();
  const trustedSenderIds = new Set(config?.trustedSenderIds ?? []);

  const watermarkStore = new WatermarkStore(workspaceDir);
  logger.info(
    `[provenance] Watermark store: ${workspaceDir}/.provenance/watermarks.json`,
  );

  const blockedWriteStore = new BlockedWriteStore(workspaceDir);
  logger.info(
    `[provenance] Blocked write store: ${workspaceDir}/.provenance/blocked-writes/`,
  );

  const policyConfig = buildPolicyConfig(
    config?.taintPolicy as any,
    config?.toolOverrides,
    config?.maxIterations,
    logger,
  );

  // Log policy config at startup
  logger.info(`[provenance] Policy config loaded:`);
  logger.info(
    `[provenance]   Taint policy: ${JSON.stringify(policyConfig.taintPolicy)}`,
  );
  logger.info(
    `[provenance]   Tool overrides: ${Object.keys(policyConfig.toolOverrides).length} tools configured`,
  );
  logger.info(
    `[provenance]   Max iterations: ${policyConfig.maxIterations}`,
  );
  if (trustedSenderIds.size > 0) {
    logger.info(
      `[provenance]   Trusted sender IDs: ${Array.from(trustedSenderIds).join(", ")}`,
    );
  }
  if (
    toolOutputTaintOverrides &&
    Object.keys(toolOutputTaintOverrides).length > 0
  ) {
    logger.info(
      `[provenance]   Tool output taint overrides: ${JSON.stringify(toolOutputTaintOverrides)}`,
    );
  }
  if (developerMode) {
    logger.info(
      `[provenance]   Developer mode: ON (taint headers will be prepended to outbound messages)`,
    );
  }

  // Per-session state
  const lastLlmNodeBySession = new Map<string, string>();
  const blockedToolsBySession = new Map<string, Set<string>>();
  const lastImpactedToolBySession = new Map<string, string>();

  // --- before_agent_start ---
  api.on(
    "before_agent_start",
    failOpen("before_agent_start", logger, (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const messages: unknown[] = event.messages ?? [];
      // Fresh session: clear watermark
      if (messages.length <= 1) {
        const cleared = watermarkStore.clearWithAudit(sessionKey);
        if (cleared) {
          const sk = shortKey(sessionKey);
          logger.info(
            `[provenance:${sk}] 🔄 Watermark cleared on fresh session start (was: ${cleared.level}, reason: ${cleared.reason})`,
          );
          watermarkStore.flush();
        }
      }
    }),
  );

  // --- context_assembled ---
  api.on(
    "context_assembled",
    failOpen("context_assembled", logger, (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const graph = store.startTurn(sessionKey);

      const initialTrust = classifyInitialTrust(ctx, trustedSenderIds);

      graph.recordContextAssembled(
        event.systemPrompt ?? "",
        event.messageCount ?? 0,
        initialTrust,
      );

      // Inherit taint watermark from previous turns
      const watermark = watermarkStore.getLevel(sessionKey);
      if (watermark) {
        const watermarkIdx = TRUST_ORDER.indexOf(watermark.level);
        const initialIdx = TRUST_ORDER.indexOf(initialTrust);
        if (watermarkIdx > initialIdx) {
          graph.addNode({
            id: "inherited-taint",
            kind: "history",
            trust: watermark.level,
            metadata: {
              reason:
                watermark.reason ??
                "inherited taint watermark from previous turn",
            },
          });
        }
      }

      const sk = shortKey(sessionKey);
      const effectiveTaint = graph.maxTaint;
      logger.info(`[provenance:${sk}] ── Turn Start ──`);
      logger.info(
        `[provenance:${sk}]   Messages: ${event.messageCount ?? 0} | System prompt: ${(event.systemPrompt ?? "").length} chars`,
      );
      logger.info(
        `[provenance:${sk}]   Initial trust: ${initialTrust} (sender: ${ctx.senderName ?? ctx.senderId ?? "unknown"}, owner: ${ctx.senderIsOwner ?? "unknown"}, group: ${ctx.groupId ?? "none"}, provider: ${ctx.messageProvider ?? "none"})`,
      );
      if (watermark && watermark.level !== initialTrust) {
        logger.info(
          `[provenance:${sk}]   Inherited taint watermark: ${watermark.level} (reason: ${watermark.reason})`,
        );
      }
      if (effectiveTaint !== initialTrust) {
        logger.info(
          `[provenance:${sk}]   Effective taint: ${effectiveTaint} (escalated from ${initialTrust})`,
        );
      }
    }),
  );

  // --- before_llm_call ---
  api.on(
    "before_llm_call",
    failOpen("before_llm_call", logger, (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const graph = store.getActive(sessionKey);
      if (!graph) return;

      const llmNodeId = graph.recordLlmCall(
        event.iteration ?? 0,
        event.tools?.length ?? 0,
      );
      lastLlmNodeBySession.set(sessionKey, llmNodeId);

      const sk = shortKey(sessionKey);

      // Process owner commands (.approve, .reset-trust)
      const isOwner =
        ctx.senderIsOwner !== undefined ? ctx.senderIsOwner : true;
      const messages = event.messages ?? [];
      const lastUserMsg = [...messages]
        .reverse()
        .find((m: any) => m.role === "user");

      if (lastUserMsg && isOwner) {
        const content =
          typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : Array.isArray(lastUserMsg.content)
              ? lastUserMsg.content
                  .filter((c: any) => c?.type === "text")
                  .map((c: any) => c.text)
                  .join("")
              : "";
        const trimmed = content.trim();

        // Process .approve <tool|all> [duration-minutes]
        const approveMatch = trimmed.match(
          /\.approve\s+(\S+)(?:\s+(\d+))?/i,
        );
        if (approveMatch) {
          const target = approveMatch[1].toLowerCase();
          const durationStr = approveMatch[2];
          const durationMinutes = durationStr
            ? parseInt(durationStr, 10)
            : null;

          if (target === "all") {
            // Approve all currently blocked tools
            const blocked = blockedToolsBySession.get(sessionKey);
            if (blocked && blocked.size > 0) {
              approvalStore.approveMultiple(
                sessionKey,
                Array.from(blocked),
                durationMinutes,
              );
              const durDesc =
                durationMinutes != null
                  ? `${durationMinutes} minutes`
                  : "this turn";
              logger.info(
                `[provenance:${sk}] ✅ Approved all: ${Array.from(blocked).join(", ")} (duration: ${durDesc})`,
              );
            }
            // Also set wildcard approval
            approvalStore.approve(sessionKey, "all", durationMinutes);
          } else {
            approvalStore.approve(sessionKey, target, durationMinutes);
            const durDesc =
              durationMinutes != null
                ? `${durationMinutes} minutes`
                : "this turn";
            logger.info(
              `[provenance:${sk}] ✅ Approved: ${target} (duration: ${durDesc})`,
            );
          }
        }

        // Process .reset-trust [level]
        const resetMatch = trimmed.match(/\.reset-trust(?:\s+([a-z]+))?/i);
        if (resetMatch) {
          const targetLevel = (resetMatch[1]?.toLowerCase() ??
            "trusted") as TrustLevel;
          const validLevels: TrustLevel[] = [
            "trusted",
            "shared",
            "external",
            "untrusted",
          ];
          if (validLevels.includes(targetLevel)) {
            const previousTaint = graph.maxTaint;
            graph.resetTaint(targetLevel);
            blockedToolsBySession.delete(sessionKey);
            approvalStore.clearAll(sessionKey);
            watermarkStore.clear(sessionKey);
            watermarkStore.flush();
            logger.info(
              `[provenance:${sk}] 🔄 Trust reset: ${previousTaint} → ${targetLevel} (owner override, watermark cleared)`,
            );
          } else {
            logger.warn(
              `[provenance:${sk}] ❌ Invalid trust level for .reset-trust: ${targetLevel}`,
            );
          }
        }
      } else if (lastUserMsg && !isOwner) {
        const content =
          typeof lastUserMsg.content === "string"
            ? lastUserMsg.content
            : "";
        if (
          content.includes(".approve") ||
          content.includes(".reset-trust")
        ) {
          logger.warn(
            `[provenance:${sk}] 🚫 Non-owner attempted security command (senderId: ${ctx.senderId ?? "unknown"})`,
          );
        }
      }

      // Evaluate policy
      const currentTools: Array<{ name: string }> = event.tools ?? [];
      const currentToolNames = currentTools.map((t: any) => t.name);
      const result = evaluateWithApprovals(
        graph,
        currentToolNames,
        policyConfig,
        approvalStore,
        sessionKey,
      );

      if (result.mode === "allow") {
        logger.info(
          `[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`,
        );
        logger.info(
          `[provenance:${sk}]   Taint: ${graph.maxTaint} | Mode: allow | Tools: ${currentToolNames.length}`,
        );
        return undefined;
      }

      if (result.block) {
        if (result.blockReason?.startsWith("Max iterations exceeded")) {
          logger.warn(
            `[provenance:${sk}]   Max iterations warning: ${result.blockReason} — allowing agent loop to handle`,
          );
          return undefined;
        }
        logger.warn(
          `[provenance:${sk}]   Turn BLOCKED: ${result.blockReason}`,
        );
        return { block: true, blockReason: result.blockReason };
      }

      // Log pending confirmations
      if (result.pendingConfirmations.length > 0) {
        const pendingNames = result.pendingConfirmations.map(
          (p) => p.toolName,
        );
        logger.warn(
          `[provenance:${sk}] ⚠️ SECURITY: Tools restricted due to ${graph.maxTaint} content in context.`,
        );
        logger.warn(
          `[provenance:${sk}]   Restricted: ${pendingNames.join(", ")}`,
        );
        lastImpactedToolBySession.set(
          sessionKey,
          pendingNames[pendingNames.length - 1],
        );
        logger.warn(
          `[provenance:${sk}]   Approve with: .approve <tool>  (or .approve all)`,
        );
      }

      const removedTools = Array.from(result.toolRemovals);
      const removedStr =
        removedTools.length > 0 ? removedTools.join(", ") : "(none)";

      logger.info(
        `[provenance:${sk}] ── LLM Call (iteration ${event.iteration ?? 0}) ──`,
      );
      logger.info(
        `[provenance:${sk}]   Taint: ${graph.maxTaint} | Mode: ${result.mode} | Tools: ${currentToolNames.length - removedTools.length}/${currentToolNames.length} | Removed: ${removedStr}`,
      );

      if (result.toolRemovals.size > 0) {
        blockedToolsBySession.set(
          sessionKey,
          new Set(result.toolRemovals),
        );

        const removalsLower = new Set(
          Array.from(result.toolRemovals).map((t) => t.toLowerCase()),
        );
        const allowedTools = currentTools.filter(
          (t: any) => !removalsLower.has(t.name.toLowerCase()),
        );

        for (const toolName of result.toolRemovals) {
          graph.recordBlockedTool(toolName, "policy", event.iteration ?? 0);
        }
        return { tools: allowedTools };
      } else {
        blockedToolsBySession.delete(sessionKey);
      }

      return undefined;
    }),
  );

  // --- before_tool_call --- (EXECUTION-LAYER ENFORCEMENT)
  api.on(
    "before_tool_call",
    failOpen("before_tool_call", logger, (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const sk = shortKey(sessionKey);
      const graph = store.getActive(sessionKey);
      const toolName = event.toolName;
      const toolNameLower = toolName.toLowerCase();

      // Memory file write protection
      if (graph && (toolNameLower === "write" || toolNameLower === "edit")) {
        const filePath = event.params?.file_path;

        if (filePath && isMemoryFile(filePath, workspaceDir)) {
          const currentTaint = graph.maxTaint;

          // Block if taint is worse than trusted
          if (currentTaint !== "trusted") {
            const fileName = basename(filePath);

            // Save blocked write to disk (never lose content)
            const content =
              toolNameLower === "write"
                ? event.params?.content ?? ""
                : event.params?.newText ?? event.params?.new_string ?? "";
            const oldText =
              toolNameLower === "edit"
                ? event.params?.oldText ?? event.params?.old_string ?? ""
                : undefined;

            blockedWriteStore.save({
              targetPath: filePath,
              content,
              operation: toolNameLower as "write" | "edit",
              oldText,
              taintLevel: currentTaint,
              reason: `Context taint: ${currentTaint}`,
              blockedAt: new Date().toISOString(),
              sessionKey,
            });

            logger.warn(
              `[provenance:${sk}] 🛑 MEMORY FILE WRITE BLOCKED (saved to staging)`,
            );
            logger.warn(
              `[provenance:${sk}]   File: ${fileName} | Taint: ${currentTaint}`,
            );
            logger.warn(
              `[provenance:${sk}]   Content saved to .provenance/blocked-writes/`,
            );

            return {
              block: true,
              blockReason:
                `Cannot write to memory file '${fileName}' — context contains ${currentTaint} content.\n` +
                `The content has been saved to .provenance/blocked-writes/ for review.\n` +
                `Use .reset-trust to clear taint and retry, or review the staged write manually.`,
            };
          }
        }
      }

      // Message tool: owner DM exception
      if (toolNameLower === "message" && isOwnerDm(ctx)) {
        // Always allow message in owner DMs regardless of taint
        return undefined;
      }

      // Existing blocked tool check
      const blocked = blockedToolsBySession.get(sessionKey);
      if (!blocked || blocked.size === 0) return undefined;

      const isBlocked = Array.from(blocked).some(
        (b) => b.toLowerCase() === toolNameLower,
      );
      if (isBlocked) {
        const blockedList = Array.from(blocked).join(", ");
        logger.warn(
          `[provenance:${sk}] 🛑 BLOCKED at execution layer: ${toolName}`,
        );
        lastImpactedToolBySession.set(sessionKey, toolName);
        return {
          block: true,
          blockReason:
            `Tool '${toolName}' is blocked by security policy. Context contains tainted content.\n` +
            `Blocked tools: ${blockedList}\n` +
            `Approve: .approve ${toolName}  (or .approve all)\n` +
            `Or use .reset-trust to clear all restrictions.`,
        };
      }
      return undefined;
    }),
  );

  // --- after_llm_call ---
  api.on(
    "after_llm_call",
    failOpen("after_llm_call", logger, (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const graph = store.getActive(sessionKey);
      if (!graph) return;

      const llmNodeId = lastLlmNodeBySession.get(sessionKey);
      const toolCalls: Array<{ name: string }> = event.toolCalls ?? [];

      for (const tc of toolCalls) {
        graph.recordToolCall(
          tc.name,
          event.iteration ?? 0,
          llmNodeId,
          resolvedToolTaints,
        );
      }

      const sk = shortKey(sessionKey);
      const toolDescriptions = toolCalls.map((tc: any) => {
        const trust = getToolTrust(tc.name, resolvedToolTaints);
        return `${tc.name}(${trust})`;
      });
      logger.info(
        `[provenance:${sk}] ── LLM Response (iteration ${event.iteration ?? 0}) ──`,
      );
      logger.info(
        `[provenance:${sk}]   Tool calls: ${toolDescriptions.length > 0 ? toolDescriptions.join(", ") : "(none)"}`,
      );
      logger.info(
        `[provenance:${sk}]   Taint after: ${graph.maxTaint}`,
      );
    }),
  );

  // --- loop_iteration_start ---
  api.on(
    "loop_iteration_start",
    failOpen(
      "loop_iteration_start",
      logger,
      (event: any, _ctx: AgentContext) => {
        if (verbose) {
          logger.info(
            `[provenance] Iteration ${event.iteration} start (${event.messageCount} messages)`,
          );
        }
      },
    ),
  );

  // --- loop_iteration_end ---
  api.on(
    "loop_iteration_end",
    failOpen(
      "loop_iteration_end",
      logger,
      (event: any, ctx: AgentContext) => {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const graph = store.getActive(sessionKey);
        if (!graph) return;
        graph.recordIterationEnd(
          event.iteration ?? 0,
          event.toolCallsMade ?? 0,
          event.willContinue ?? false,
        );

        const sk = shortKey(sessionKey);
        logger.info(
          `[provenance:${sk}] ── Iteration ${event.iteration ?? 0} End ──`,
        );
        logger.info(
          `[provenance:${sk}]   Tool calls made: ${event.toolCallsMade ?? 0} | Will continue: ${event.willContinue ?? false}`,
        );
      },
    ),
  );

  // --- before_response_emit ---
  api.on(
    "before_response_emit",
    failOpen(
      "before_response_emit",
      logger,
      (event: any, ctx: AgentContext) => {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const graph = store.getActive(sessionKey);
        if (!graph) return;

        graph.recordOutput(event.content?.length ?? 0);

        const taintLevel = graph.maxTaint;
        const currentWatermark = watermarkStore.getLevel(sessionKey);
        const taintReason = buildTaintReason(
          graph,
          currentWatermark?.reason,
        );

        // Clear turn-scoped approvals
        approvalStore.clearTurnScoped(sessionKey);

        const summary = store.completeTurn(sessionKey);
        if (!summary) return;

        // Persist watermark
        const wmReason = buildWatermarkReason(graph);
        watermarkStore.escalate(
          sessionKey,
          summary.maxTaint,
          wmReason,
          wmReason,
        );
        watermarkStore.flush();

        const sk = shortKey(sessionKey);

        logger.info(`[provenance:${sk}] ── Turn Complete ──`);
        logger.info(
          `[provenance:${sk}]   Final taint: ${summary.maxTaint}`,
        );
        logger.info(
          `[provenance:${sk}]   External sources: ${summary.externalSources.length > 0 ? summary.externalSources.join(", ") : "(none)"}`,
        );
        logger.info(
          `[provenance:${sk}]   Tools used: ${summary.toolsUsed.length > 0 ? summary.toolsUsed.join(", ") : "(none)"}`,
        );
        logger.info(
          `[provenance:${sk}]   Tools blocked: ${summary.toolsBlocked.length > 0 ? summary.toolsBlocked.join(", ") : "(none)"}`,
        );
        logger.info(
          `[provenance:${sk}]   Iterations: ${summary.iterationCount} | Nodes: ${summary.nodeCount} | Edges: ${summary.edgeCount}`,
        );

        blockedToolsBySession.delete(sessionKey);

        // Developer mode header
        if (developerMode && event.content) {
          const lastImpacted =
            lastImpactedToolBySession.get(sessionKey) ?? "none";
          const taintEmoji =
            taintLevel === "trusted"
              ? "🟢"
              : taintLevel === "shared"
                ? "🟡"
                : taintLevel === "external"
                  ? "🟠"
                  : "🔴";
          const header = `${taintEmoji} [taint: ${taintLevel} | reason: ${taintReason} | last impacted: ${lastImpacted}]`;
          return { content: header + "\n" + event.content };
        }
      },
    ),
  );

  return { store, approvalStore };
}
