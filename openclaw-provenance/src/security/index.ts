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
  getToolMode,
  type PolicyConfig,
  type PolicyMode,
  type ToolOverride,
} from "./policy-engine.js";
import {
  getToolTrust,
  buildToolOutputTaintMap,
  TRUST_ORDER,
  minTrust,
} from "./trust-levels.js";
import type { TrustLevel } from "./trust-levels.js";
import { ApprovalStore } from "./approval-store.js";
import { isMemoryFile } from "./memory-file-detector.js";
import { basename } from "node:path";
import {
  resolveToolKey,
  buildCompositeToolMap,
  DEFAULT_COMPOSITE_OUTPUT_TAINTS,
  DEFAULT_COMPOSITE_TOOL_OVERRIDES,
  type CompositeToolConfig,
} from "./composite-tools.js";
import {
  extractToolSourceUris,
  buildUriExtractorMap,
  type UriExtractorConfig,
} from "./uri-extractor.js";
import {
  buildUriTrustConfig,
  classifyUri,
  classifyUris,
  type UriTrustConfig,
} from "./uri-trust.js";
import type { UriTaintRecord } from "./watermark-store.js";

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

/** Per-agent overrides for taint policy and tool classifications */
export interface AgentPolicyOverride {
  taintPolicy?: Partial<Record<string, PolicyMode>>;
  toolOverrides?: Record<string, ToolOverride>;
  toolOutputTaints?: Record<string, TrustLevel>;
  /** Per-agent URI trust pattern overrides */
  uriTrust?: Record<string, TrustLevel>;
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
  /** Per-agent policy overrides keyed by agent ID */
  agentOverrides?: Record<string, AgentPolicyOverride>;
  /** Custom composite tool definitions (built-ins for message/browser are automatic) */
  compositeTools?: Record<string, CompositeToolConfig>;
  /** Custom URI extractor configs for plugin tools */
  uriExtractors?: Record<string, UriExtractorConfig>;
  /** URI trust patterns — glob-like URI → trust level mappings */
  uriTrust?: Record<string, TrustLevel>;
  /** Trust level for messages with no senderId (default: "shared") */
  missingIdentityTrust?: TrustLevel;
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
  missingIdentityTrust: TrustLevel = "shared",
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

  // No senderId — system-internal injection (sub-agent announce, cron
  // delivery, exec completion notification). Trust level is configurable.
  return missingIdentityTrust;
}

/**
 * Check if the current session is an owner DM (for message tool exception).
 */
function isOwnerDm(ctx: AgentContext): boolean {
  // Owner DM: direct owner session, or sub-agent spawned by owner (no group context)
  return (ctx.senderIsOwner === true || !!ctx.spawnedBy) && !ctx.groupId;
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
 * When profiling is enabled, logs execution time for hooks > 1ms.
 */
function failOpen<T extends (...args: any[]) => any>(
  hookName: string,
  logger: { error(...args: any[]): void; info?(...args: any[]): void },
  handler: T,
  profile = false,
): T {
  return ((...args: any[]) => {
    const t0 = profile ? performance.now() : 0;
    try {
      const result = handler(...args);
      if (profile) {
        const ms = performance.now() - t0;
        if (ms > 1) {
          (logger as any).info?.(
            `[provenance] ⏱ ${hookName}: ${ms.toFixed(1)}ms`,
          );
        }
      }
      return result;
    } catch (err) {
      const ms = profile ? performance.now() - t0 : -1;
      logger.error(
        `[provenance] FAIL-OPEN: Error in ${hookName} hook${ms >= 0 ? ` after ${ms.toFixed(1)}ms` : ""} — agent continues without taint tracking`,
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
  // Merge composite output taints into tool output taints
  const mergedToolOutputTaintOverrides = {
    ...DEFAULT_COMPOSITE_OUTPUT_TAINTS,
    ...(toolOutputTaintOverrides ?? {}),
  };
  const resolvedToolTaints = buildToolOutputTaintMap(mergedToolOutputTaintOverrides);
  const verbose = config?.verbose ?? false;
  const developerMode = config?.developerMode ?? false;

  // Build composite tools, URI extractors, and URI trust config
  const compositeTools = buildCompositeToolMap(config?.compositeTools);
  const uriExtractors = buildUriExtractorMap(config?.uriExtractors);
  const workspaceDir = config?.workspaceDir ?? process.cwd();
  const defaultUriTrustConfig = buildUriTrustConfig(config?.uriTrust, workspaceDir);
  const trustedSenderIds = new Set(config?.trustedSenderIds ?? []);

  const watermarkStore = new WatermarkStore(workspaceDir);
  logger.info(
    `[provenance] Watermark store: ${workspaceDir}/.provenance/watermarks.json`,
  );

  const blockedWriteStore = new BlockedWriteStore(workspaceDir);
  logger.info(
    `[provenance] Blocked write store: ${workspaceDir}/.provenance/blocked-writes/`,
  );

  // Merge composite tool overrides with user-provided tool overrides
  const mergedToolOverridesForPolicy = {
    ...DEFAULT_COMPOSITE_TOOL_OVERRIDES,
    ...(config?.toolOverrides ?? {}),
  };
  const defaultPolicyConfig = buildPolicyConfig(
    config?.taintPolicy as any,
    mergedToolOverridesForPolicy,
    config?.maxIterations,
    logger,
  );

  // Build per-agent policy configs, tool taint maps, and URI trust configs
  const agentOverrides = config?.agentOverrides ?? {};
  const agentPolicyConfigs = new Map<string, PolicyConfig>();
  const agentToolTaints = new Map<string, Record<string, TrustLevel>>();
  const agentUriTrustConfigs = new Map<string, UriTrustConfig>();

  for (const [agentId, overrides] of Object.entries(agentOverrides)) {
    // Merge taint policy: agent overrides on top of defaults
    const mergedTaintPolicy = {
      ...(config?.taintPolicy as Partial<Record<string, PolicyMode>> ?? {}),
      ...(overrides.taintPolicy ?? {}),
    };
    // Merge tool overrides: agent overrides on top of defaults (include composite defaults)
    const mergedToolOverrides = {
      ...DEFAULT_COMPOSITE_TOOL_OVERRIDES,
      ...(config?.toolOverrides ?? {}),
      ...(overrides.toolOverrides ?? {}),
    };
    agentPolicyConfigs.set(
      agentId,
      buildPolicyConfig(mergedTaintPolicy as any, mergedToolOverrides, config?.maxIterations, logger),
    );

    // Merge tool output taints: agent overrides on top of defaults (include composite)
    if (overrides.toolOutputTaints) {
      const mergedOutputTaints = {
        ...DEFAULT_COMPOSITE_OUTPUT_TAINTS,
        ...(toolOutputTaintOverrides ?? {}),
        ...overrides.toolOutputTaints,
      };
      agentToolTaints.set(agentId, mergedOutputTaints);
    }

    // Per-agent URI trust (Phase 4): agent patterns overlay default patterns
    if (overrides.uriTrust) {
      const mergedUriTrust = {
        ...(config?.uriTrust ?? {}),
        ...overrides.uriTrust,
      };
      agentUriTrustConfigs.set(
        agentId,
        buildUriTrustConfig(mergedUriTrust, workspaceDir),
      );
    }

    logger.info(`[provenance] Agent override loaded for '${agentId}':`);
    if (overrides.taintPolicy) {
      logger.info(`[provenance]   Taint policy: ${JSON.stringify(overrides.taintPolicy)}`);
    }
    if (overrides.toolOverrides) {
      logger.info(`[provenance]   Tool overrides: ${Object.keys(overrides.toolOverrides).length} tools`);
    }
    if (overrides.toolOutputTaints) {
      logger.info(`[provenance]   Tool output taints: ${JSON.stringify(overrides.toolOutputTaints)}`);
    }
    if (overrides.uriTrust) {
      logger.info(`[provenance]   URI trust patterns: ${Object.keys(overrides.uriTrust).length} patterns`);
    }
  }

  /** Resolve the effective policy config for a given agent */
  function getPolicyConfig(agentId?: string): PolicyConfig {
    if (agentId && agentPolicyConfigs.has(agentId)) {
      return agentPolicyConfigs.get(agentId)!;
    }
    return defaultPolicyConfig;
  }

  /** Resolve the effective tool taint map for a given agent */
  function getResolvedToolTaints(agentId?: string): Record<string, TrustLevel> {
    if (agentId && agentToolTaints.has(agentId)) {
      return buildToolOutputTaintMap(agentToolTaints.get(agentId));
    }
    return resolvedToolTaints;
  }

  /** Resolve the effective URI trust config for a given agent */
  function getUriTrustConfig(agentId?: string): UriTrustConfig {
    if (agentId && agentUriTrustConfigs.has(agentId)) {
      return agentUriTrustConfigs.get(agentId)!;
    }
    return defaultUriTrustConfig;
  }

  // Log policy config at startup
  logger.info(`[provenance] Default policy config loaded:`);
  logger.info(
    `[provenance]   Taint policy: ${JSON.stringify(defaultPolicyConfig.taintPolicy)}`,
  );
  logger.info(
    `[provenance]   Tool overrides: ${Object.keys(defaultPolicyConfig.toolOverrides).length} tools configured`,
  );
  logger.info(
    `[provenance]   Max iterations: ${defaultPolicyConfig.maxIterations}`,
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
  if (Object.keys(agentOverrides).length > 0) {
    logger.info(
      `[provenance]   Agent overrides: ${Object.keys(agentOverrides).join(", ")}`,
    );
  }
  logger.info(
    `[provenance]   Composite tools: ${Object.keys(compositeTools).join(", ")}`,
  );
  logger.info(
    `[provenance]   URI trust patterns: ${defaultUriTrustConfig.patterns.length} (${config?.uriTrust ? Object.keys(config.uriTrust).length + " user + " : ""}built-in defaults)`,
  );

  // Per-session state
  const lastLlmNodeBySession = new Map<string, string>();
  const blockedToolsBySession = new Map<string, Set<string>>();
  const lastImpactedToolBySession = new Map<string, string>();
  const lastProcessedMessageCount = new Map<string, number>();
  const sessionAgentMap = new Map<string, string>();

  /** Shorthand: failOpen with profiling enabled when verbose is on */
  const profiled = <T extends (...args: any[]) => any>(
    hookName: string,
    handler: T,
  ) => failOpen(hookName, logger, handler, verbose);

  // --- Latency tracking ---
  // Tracks wall-clock time from the earliest hook (before_agent_start) through
  // the processing pipeline to help diagnose message-to-typing-indicator latency.
  const turnStartTimes = new Map<string, number>();

  // --- before_agent_start ---
  // NOTE: This hook may not fire on all OpenClaw versions. Watermark clearing
  // is in context_assembled. Latency tracking now also uses context_assembled
  // as the baseline since before_agent_start is unreliable.

  // --- context_assembled ---
  api.on(
    "context_assembled",
    profiled("context_assembled", (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      if (ctx.agentId) sessionAgentMap.set(sessionKey, ctx.agentId);
      turnStartTimes.set(sessionKey, performance.now());
      const graph = store.startTurn(sessionKey);

      // Fresh session detection: clear watermark only when messageCount <= 1
      // (context_assembled has the real assembled message count, unlike
      // before_agent_start which may only have the triggering message)
      const messageCount = event.messageCount ?? 0;
      if (messageCount <= 1) {
        const cleared = watermarkStore.clearWithAudit(sessionKey);
        if (cleared) {
          const sk = shortKey(sessionKey);
          logger.info(
            `[provenance:${sk}] 🔄 Watermark cleared on fresh session (messageCount: ${messageCount}, was: ${cleared.level}, reason: ${cleared.reason})`,
          );
          watermarkStore.flush();
        }
      }

      const initialTrust = classifyInitialTrust(ctx, trustedSenderIds, config?.missingIdentityTrust);

      graph.recordContextAssembled(
        event.systemPrompt ?? "",
        event.messageCount ?? 0,
        initialTrust,
      );

      // Peek ahead: if the owner is about to .reset-trust, skip watermark
      // inheritance so the graph starts clean rather than inheriting taint
      // that will be immediately undone.
      const messages = event.messages ?? [];
      const peekLastUserMsg = [...messages]
        .reverse()
        .find((m: any) => m.role === "user");
      const peekContent = peekLastUserMsg
        ? typeof peekLastUserMsg.content === "string"
          ? peekLastUserMsg.content
          : Array.isArray(peekLastUserMsg.content)
            ? peekLastUserMsg.content
                .filter((c: any) => c?.type === "text")
                .map((c: any) => c.text)
                .join("")
            : ""
        : "";
      const ownerIsResettingTrust =
        ctx.senderIsOwner === true &&
        /\.reset-trust(?:\s+[a-z]+)?/i.test(peekContent.trim());

      // Inherit taint watermark from previous turns
      const watermark = watermarkStore.getLevel(sessionKey);
      if (watermark && !ownerIsResettingTrust) {
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
    profiled("before_llm_call", (event: any, ctx: AgentContext) => {
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
      // Track processed message indices to prevent repeated firing from conversation history.
      const isOwner = ctx.senderIsOwner === true;
      const messages = event.messages ?? [];
      const lastUserMsg = [...messages]
        .reverse()
        .find((m: any) => m.role === "user");
      // Deduplicate: only process commands from NEW messages (not replayed history).
      // Use message count as a proxy — if we've seen this message count before, skip command processing.
      const messageCount = event.messageCount ?? messages.length;
      const lastProcessedCount = lastProcessedMessageCount.get(sessionKey) ?? 0;
      const isNewMessage = messageCount > lastProcessedCount;
      if (messageCount > 0) {
        lastProcessedMessageCount.set(sessionKey, messageCount);
      }

      if (lastUserMsg && isOwner && isNewMessage) {
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
          if (ctx.senderIsOwner === undefined) {
            logger.error(
              `[provenance:${sk}] 🚫 Security command IGNORED: senderIsOwner unavailable — extended security hooks required (senderId: ${ctx.senderId ?? "unknown"})`,
            );
          } else {
            logger.warn(
              `[provenance:${sk}] 🚫 Non-owner attempted security command (senderId: ${ctx.senderId ?? "unknown"})`,
            );
          }
        }
      }

      // Latency tracking: log time from context_assembled to first LLM call
      const iteration = event.iteration ?? 0;
      if (iteration <= 1 && turnStartTimes.has(sessionKey)) {
        const turnT0 = turnStartTimes.get(sessionKey);
        if (turnT0 !== undefined) {
          const latencyMs = performance.now() - turnT0;
          logger.info(
            `[provenance:${sk}] ⏱ ctx_assembled→first_llm: ${latencyMs.toFixed(0)}ms`,
          );
          turnStartTimes.delete(sessionKey);
        }
      }

      // Evaluate policy (agent-aware)
      const currentTools: Array<{ name: string }> = event.tools ?? [];
      const currentToolNames = currentTools.map((t: any) => t.name);
      const agentId = sessionAgentMap.get(sessionKey);
      const effectivePolicyConfig = getPolicyConfig(agentId);
      const result = evaluateWithApprovals(
        graph,
        currentToolNames,
        effectivePolicyConfig,
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
    profiled("before_tool_call", (event: any, ctx: AgentContext) => {
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

      // Resolve composite key for policy checks
      const params = event.params ?? {};
      const toolKey = resolveToolKey(toolName, params, compositeTools);
      const toolKeyLower = toolKey.toLowerCase();

      // Message tool: owner DM exception
      if (toolNameLower === "message" && isOwnerDm(ctx)) {
        // Always allow message in owner DMs regardless of taint
        return undefined;
      }

      // Composite key policy check: if the composite key has an explicit
      // "allow" override at the current taint level, let it through even
      // if the bare tool is blocked (e.g., message.send is always allowed)
      if (graph && toolKey !== toolName) {
        const agentId = sessionAgentMap.get(sessionKey);
        const effectivePolicyConfig = getPolicyConfig(agentId);
        const compositeOverride =
          effectivePolicyConfig.toolOverrides[toolKeyLower];
        if (compositeOverride) {
          const mode =
            compositeOverride[graph.maxTaint] ?? compositeOverride["*"];
          if (mode === "allow") {
            return undefined; // Composite key explicitly allowed
          }
        }
      }

      // Real-time policy re-evaluation against current graph taint.
      // This catches tools that were allowed at before_llm_call time but
      // should be blocked now (e.g., parallel tool calls where an earlier
      // tool in the same batch escalated taint via after_llm_call).
      if (graph) {
        const agentId = sessionAgentMap.get(sessionKey);
        const effectivePolicyConfig = getPolicyConfig(agentId);
        const mode = getToolMode(toolKeyLower, graph.maxTaint, effectivePolicyConfig);
        if (mode === "restrict") {
          logger.warn(
            `[provenance:${sk}] 🛑 BLOCKED at execution layer (real-time re-eval): ${toolName} | taint: ${graph.maxTaint}`,
          );
          lastImpactedToolBySession.set(sessionKey, toolName);
          return {
            block: true,
            blockReason:
              `Tool '${toolName}' is restricted at taint level '${graph.maxTaint}'.\n` +
              `Use .reset-trust to clear taint, or review the context.`,
          };
        }
        if (mode === "confirm" && !approvalStore.isApproved(sessionKey, toolKeyLower)) {
          logger.warn(
            `[provenance:${sk}] 🛑 BLOCKED at execution layer (real-time re-eval, needs approval): ${toolName} | taint: ${graph.maxTaint}`,
          );
          lastImpactedToolBySession.set(sessionKey, toolName);
          return {
            block: true,
            blockReason:
              `Tool '${toolName}' requires approval at taint level '${graph.maxTaint}'.\n` +
              `Approve: .approve ${toolName}  (or .approve all)\n` +
              `Or use .reset-trust to clear all restrictions.`,
          };
        }
      }

      // Fallback: stale blocked tool check (defense in depth)
      const blocked = blockedToolsBySession.get(sessionKey);
      if (!blocked || blocked.size === 0) return undefined;

      const isBlocked = Array.from(blocked).some(
        (b) =>
          b.toLowerCase() === toolNameLower ||
          b.toLowerCase() === toolKeyLower,
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
    profiled("after_llm_call", (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const graph = store.getActive(sessionKey);
      if (!graph) return;

      const llmNodeId = lastLlmNodeBySession.get(sessionKey);
      const toolCalls: Array<{ name: string; params?: Record<string, unknown> }> =
        event.toolCalls ?? [];

      const agentId = sessionAgentMap.get(sessionKey);
      const effectiveToolTaints = getResolvedToolTaints(agentId);
      const effectiveUriTrustConfig = getUriTrustConfig(agentId);

      // Owner DM detection for message trust exception
      const ownerDm = isOwnerDm(ctx);

      for (const tc of toolCalls) {
        const params = tc.params ?? {};
        // Resolve composite key (e.g., message.send, browser.navigate)
        const toolKey = resolveToolKey(tc.name, params, compositeTools);

        // Extract source URIs
        const sourceUris = extractToolSourceUris(
          toolKey,
          tc.name,
          params,
          uriExtractors,
        );

        // Compute tool trust using composite key
        const toolTrust = getToolTrust(toolKey, effectiveToolTaints);

        // Diagnostic: log agent ID resolution for debugging multi-agent taint issues
        if (developerMode) {
          const sk = shortKey(sessionKey);
          logger.info(
            `[provenance:${sk}] 🔍 Tool trust resolution: agentId=${agentId ?? "NONE"} tool=${toolKey} toolTrust=${toolTrust} hasAgentOverride=${agentId ? agentToolTaints.has(agentId) : false}`,
          );
        }

        // Compute URI trust (overrides tool trust if matched)
        let effectiveTrust = toolTrust;
        if (sourceUris.length > 0) {
          const uriTrust = classifyUris(sourceUris, effectiveUriTrustConfig);
          if (uriTrust !== undefined) {
            effectiveTrust = uriTrust;
          }
        }

        // Owner DM exception: message read actions from owner are trusted
        if (ownerDm && toolKey.startsWith("message.") && effectiveTrust !== "trusted") {
          effectiveTrust = "trusted";
        }

        graph.recordToolCall(
          toolKey, // Use composite key as the tool name in the graph
          event.iteration ?? 0,
          llmNodeId,
          effectiveToolTaints,
          { sourceUris, effectiveTrust },
        );
      }

      const sk = shortKey(sessionKey);
      const toolDescriptions = toolCalls.map((tc: any) => {
        const params = tc.params ?? {};
        const toolKey = resolveToolKey(tc.name, params, compositeTools);
        const toolTrust = getToolTrust(toolKey, effectiveToolTaints);
        const sourceUris = extractToolSourceUris(toolKey, tc.name, params, uriExtractors);
        if (sourceUris.length > 0) {
          const uriTrust = classifyUris(sourceUris, effectiveUriTrustConfig);
          const effective = uriTrust ?? toolTrust;
          return `${toolKey}(${effective}${uriTrust ? ` uri:${sourceUris[0]}` : ""})`;
        }
        return `${toolKey}(${toolTrust})`;
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
    profiled(
      "loop_iteration_start",
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
    profiled(
      "loop_iteration_end",
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
    profiled(
      "before_response_emit",
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

        // Collect URI taint records from the completed graph
        const agentId = sessionAgentMap.get(sessionKey);
        const effectiveToolTaints = getResolvedToolTaints(agentId);
        const effectiveUriTrustConfig = getUriTrustConfig(agentId);
        const uriTaintRecords: UriTaintRecord[] = graph
          .getAllNodes()
          .filter(
            (n) => n.kind === "tool_call" && n.sourceUris?.length,
          )
          .flatMap((n) => {
            const toolKey = n.tool!;
            const toolTrust = getToolTrust(toolKey, effectiveToolTaints);
            return n.sourceUris!.map((uri) => {
              const uriTrust = classifyUri(uri, effectiveUriTrustConfig);
              return {
                uri,
                toolTrust,
                uriTrust,
                effectiveTrust: uriTrust ?? toolTrust,
                tool: toolKey,
                firstSeenAt: new Date(n.timestamp).toISOString(),
                turnId: graph.turnId,
              } satisfies UriTaintRecord;
            });
          });

        // Persist watermark with URI taint records
        const wmReason = buildWatermarkReason(graph);
        watermarkStore.escalate(
          sessionKey,
          summary.maxTaint,
          wmReason,
          wmReason,
          uriTaintRecords.length > 0 ? uriTaintRecords : undefined,
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
          // Include URI sources in header if available
          const uriSummary = uriTaintRecords
            .filter((r) => r.effectiveTrust !== "trusted")
            .map((r) => `${r.tool}(${truncate(r.uri, 40)})`)
            .slice(0, 3);
          const uriPart = uriSummary.length > 0 ? ` | sources: ${uriSummary.join(", ")}` : "";
          const header = `${taintEmoji} [taint: ${taintLevel} | reason: ${taintReason} | last impacted: ${lastImpacted}${uriPart}]`;
          return { content: header + "\n" + event.content };
        }
      },
    ),
  );

  return { store, approvalStore };
}
