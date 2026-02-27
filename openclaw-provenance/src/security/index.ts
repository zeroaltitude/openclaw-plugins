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
  recordTabUrls,
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
  registerCommand?(opts: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: any) => { text: string } | Promise<{ text: string }>;
  }): void;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
  /** Original message source before delivery channel resolution.
   *  E.g. "heartbeat", "cron-event", "exec-event". When present,
   *  used for trust classification instead of messageProvider. */
  sourceProvider?: string;
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

/**
 * Browser composite keys that read page content and should defer taint
 * classification until after execution when the source URL is unknown.
 *
 * These tools operate on existing browser tabs/pages. The actual URL isn't
 * always known at call time (e.g., when called without targetId, or when
 * targetId can't be resolved via the tab URL map). Applying the default
 * "external" output taint prematurely would cause self-blocking: the tool
 * escalates taint in after_llm_call, then before_tool_call blocks it.
 *
 * Instead, taint is deferred to the current graph level. after_tool_call
 * classifies the actual URL from the tool result and escalates if needed.
 */
const BROWSER_DEFERRED_TOOLS = new Set([
  "browser.snapshot",
  "browser.screenshot",
  "browser.console",
  "browser.pdf",
  "browser.navigate",
]);

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
  // Check sourceProvider first — it reflects the true message origin
  // (e.g. "heartbeat") even when messageProvider reflects the delivery
  // channel (e.g. "discord"). Falls back to messageProvider when
  // sourceProvider is not set.
  const effectiveProvider = ctx.sourceProvider ?? ctx.messageProvider;
  if (
    !effectiveProvider ||
    effectiveProvider === "heartbeat" ||
    effectiveProvider === "cron" ||
    effectiveProvider === "cron-event" ||
    effectiveProvider === "exec-event" ||
    effectiveProvider === "webchat"
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
 *
 * Only interactive owner sessions qualify — subagent sessions do NOT get this
 * exception. Subagents are automated and may inherit tainted context from their
 * parent; granting them blanket message-send bypass would enable taint laundering.
 */
function isOwnerDm(ctx: AgentContext): boolean {
  return ctx.senderIsOwner === true && !ctx.groupId && !ctx.spawnedBy;
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

  // Check for watermark inheritance (taint carried from previous turn)
  const inherited = nodes.find((n) => n.id === "inherited-taint");
  if (inherited && TRUST_ORDER.indexOf(inherited.trust) >= taintIdx) {
    return truncate(`watermark: ${watermarkReason ?? "prev turn"}`, 50);
  }

  // Check for parent session inheritance (cross-session taint propagation)
  const parentInherited = nodes.find((n) => n.id === "inherited-parent-taint");
  if (parentInherited && TRUST_ORDER.indexOf(parentInherited.trust) >= taintIdx) {
    const parentKey = (parentInherited.metadata?.parentSessionKey as string) ?? "unknown";
    return truncate(`parent: ${shortKey(parentKey)}`, 50);
  }

  // Check for tool-call escalation (most common cause during a turn)
  const toolNodes = nodes.filter(
    (n) =>
      n.kind === "tool_call" && TRUST_ORDER.indexOf(n.trust) >= taintIdx,
  );
  if (toolNodes.length > 0) {
    const toolParts = toolNodes.map((n) => {
      const name = n.tool ?? "unknown";
      const uris = n.sourceUris?.length ? n.sourceUris.map((u: string) => truncate(u, 60)).join(", ") : null;
      return uris ? `${name}(${uris})` : name;
    });
    return truncate(`tools: ${toolParts.join(", ") || "unknown"}`, 120);
  }

  // Check for context classification (initial trust from sender/provider)
  const histNode = nodes.find(
    (n) =>
      n.kind === "history" &&
      n.id !== "inherited-taint" &&
      n.id !== "inherited-parent-taint" &&
      TRUST_ORDER.indexOf(n.trust) >= taintIdx,
  );
  if (histNode) {
    // This is the recordContextAssembled history node — taint from sender classification
    return truncate(`sender classification (${(histNode.metadata?.reason as string) ?? `${histNode.metadata?.messageCount ?? 0} msgs`})`, 50);
  }

  if (graph.maxTaint === "trusted") {
    return "clean";
  }
  return "unknown source";
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

  const resolvedMissingIdentityTrust = config?.missingIdentityTrust ?? "shared";
  logger.info(
    `[provenance] missingIdentityTrust: ${resolvedMissingIdentityTrust}${config?.missingIdentityTrust ? " (from config)" : " (default)"}`,
  );

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

    // Merge tool output taints: agent overrides on top of defaults (include composite).
    // Pre-build the resolved map at startup to avoid rebuilding on every call.
    if (overrides.toolOutputTaints) {
      const mergedOutputTaints = {
        ...DEFAULT_COMPOSITE_OUTPUT_TAINTS,
        ...(toolOutputTaintOverrides ?? {}),
        ...overrides.toolOutputTaints,
      };
      agentToolTaints.set(agentId, buildToolOutputTaintMap(mergedOutputTaints));
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

  /** Resolve the effective tool taint map for a given agent (pre-built at startup) */
  function getResolvedToolTaints(agentId?: string): Record<string, TrustLevel> {
    if (agentId && agentToolTaints.has(agentId)) {
      return agentToolTaints.get(agentId)!;
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

  // --- /provenance slash command ---
  api.registerCommand?.({
    name: "provenance",
    description: "Show current taint/provenance state for all active sessions",
    handler: () => {
      const watermarks = watermarkStore.listAll();
      const entries = Object.entries(watermarks);
      if (entries.length === 0) {
        return { text: "🟢 No active taint watermarks. All sessions trusted." };
      }
      const taintEmoji = (level: string) =>
        level === "trusted" ? "🟢"
          : level === "shared" ? "🟡"
            : level === "external" ? "🟠"
              : "🔴";
      const lines = entries.map(([key, entry]) => {
        const short = key.length > 20 ? "…" + key.slice(-16) : key;
        return `${taintEmoji(entry.level)} \`${short}\`: ${entry.level} (${entry.reason})`;
      });
      return { text: `**Provenance Status**\n${lines.join("\n")}` };
    },
  });

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
  // Track sessionKey from before_tool_call so after_tool_call can use it
  // (core passes sessionKey: undefined to after_tool_call in some code paths)
  let lastToolCallSessionKey = "unknown";
  const turnStartTaintBySession = new Map<string, { level: TrustLevel; reason: string }>();

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

      // Scan conversation messages for browser.tabs responses to populate tab URL map.
      // This enables URI trust classification for browser.snapshot/screenshot calls
      // that use targetId instead of targetUrl.
      const ctxMessages = event.messages ?? [];
      let tabsFound = 0;
      for (const msg of ctxMessages) {
        // Check both "tool" role and assistant content parts (tool results may
        // appear as either depending on the provider message format)
        const contents: string[] = [];
        if (typeof msg.content === "string") {
          contents.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === "string") contents.push(part);
            else if (part?.type === "text" && typeof part.text === "string") contents.push(part.text);
            else if (part?.type === "tool_result" && typeof part.content === "string") contents.push(part.content);
          }
        }
        for (const raw of contents) {
          if (!raw.includes('"tabs"')) continue;
          // Extract tab URLs from browser.tabs responses for URI trust resolution.
          // Content may be wrapped in EXTERNAL_UNTRUSTED_CONTENT markers — try
          // raw first, then strip wrappers and find the JSON object.
          const candidates = [
            raw,
            // Strip content markers: find first { to last }
            raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
          ];
          for (const candidate of candidates) {
            if (!candidate) continue;
            try {
              const parsed = JSON.parse(candidate);
              if (parsed?.tabs && Array.isArray(parsed.tabs)) {
                recordTabUrls(parsed.tabs);
                tabsFound += parsed.tabs.length;
                break;
              }
            } catch {
              // Try next candidate
            }
          }
        }
      }
      if (tabsFound > 0) {
        logger.info(`[provenance:${shortKey(sessionKey)}]   BROWSER_TAB_URLS: seeded ${tabsFound} tab URL(s) from conversation history`);
      }

      // Also scan for browser tool results containing { targetId, url } pairs.
      // browser.snapshot/screenshot results include these in their details,
      // enabling URI trust resolution for subsequent calls using the same targetId.
      let browserUrlsFound = 0;
      for (const msg of ctxMessages) {
        const contents: string[] = [];
        if (typeof msg.content === "string") {
          contents.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === "string") contents.push(part);
            else if (part?.type === "text" && typeof part.text === "string") contents.push(part.text);
            else if (part?.type === "tool_result" && typeof part.content === "string") contents.push(part.content);
          }
        }
        for (const raw of contents) {
          if (!raw.includes('"targetId"') || !raw.includes('"url"')) continue;
          const candidates = [
            raw,
            raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
          ];
          for (const candidate of candidates) {
            if (!candidate) continue;
            try {
              const parsed = JSON.parse(candidate);
              // Direct { targetId, url } (e.g., from browser tool result top-level)
              if (typeof parsed?.targetId === "string" && typeof parsed?.url === "string") {
                recordTabUrls([{ targetId: parsed.targetId, url: parsed.url }]);
                browserUrlsFound++;
                break;
              }
              // Nested in details: { details: { targetId, url } }
              if (typeof parsed?.details?.targetId === "string" && typeof parsed?.details?.url === "string") {
                recordTabUrls([{ targetId: parsed.details.targetId, url: parsed.details.url }]);
                browserUrlsFound++;
                break;
              }
            } catch {
              // Try next candidate
            }
          }
        }
      }
      if (browserUrlsFound > 0) {
        logger.info(`[provenance:${shortKey(sessionKey)}]   BROWSER_RESULT_URLS: seeded ${browserUrlsFound} URL(s) from browser tool results in conversation history`);
      }

      // Probabilistic pruning: ~1% of turns, remove watermarks older than 24h.
      // Prevents unbounded growth from ephemeral subagent sessions.
      if (Math.random() < 0.01) {
        const pruned = watermarkStore.pruneOlderThan(24 * 60 * 60 * 1000);
        if (pruned > 0) {
          logger.info(`[provenance] Pruned ${pruned} stale watermark(s) older than 24h`);
        }
      }

      const { graph, sealedPrevious } = store.startTurn(sessionKey);

      // If a previous turn was interrupted (sealed without completing),
      // persist its watermark escalation now so taint is never silently lost.
      if (sealedPrevious) {
        const sealedMaxTaint = sealedPrevious.summary().maxTaint;
        if (sealedMaxTaint && sealedMaxTaint !== "trusted") {
          const agentId = sessionAgentMap.get(sessionKey) ?? ctx.agentId ?? "unknown";
          const sealedTools = sealedPrevious.summary().toolsUsed;
          const sealedReason = `interrupted turn sealed with tools: ${sealedTools.length > 0 ? sealedTools.join(", ") : "(none)"}`;
          watermarkStore.escalate(
            sessionKey,
            sealedMaxTaint,
            sealedReason,
            sealedReason,
          );
          watermarkStore.flush();
          logger.warn(
            `[provenance:${shortKey(sessionKey)}] ⚠ SEALED_PREVIOUS_ESCALATION: previous turn was interrupted (sealed by overlapping message). ` +
            `Sealed turn maxTaint=${sealedMaxTaint}, tools=${sealedTools.length > 0 ? sealedTools.join(", ") : "(none)"}. ` +
            `Watermark escalated to ${sealedMaxTaint}.`,
          );
        }
      }

      // Watermark clearing is ONLY allowed via explicit owner commands:
      //   - .reset-trust  (processed in before_llm_call)
      //   - /new           (creates a new session key with no watermark entry)
      // Never clear based on messageCount — it's unreliable in thread/channel
      // contexts where each turn may report messageCount=1 despite being an
      // ongoing conversation.

      const initialTrust = classifyInitialTrust(ctx, trustedSenderIds, config?.missingIdentityTrust);

      graph.recordContextAssembled(
        event.systemPrompt ?? "",
        event.messageCount ?? 0,
        initialTrust,
      );

      // Early reset: execute .reset-trust atomically at context assembly time.
      // This ensures the watermark is cleared BEFORE taint is reported to the
      // user, so the reported taint level is always ground truth. Previously
      // this was a "peek-ahead" that skipped inheritance but deferred the actual
      // clear to before_llm_call — if execution failed there (e.g., bad regex),
      // the reported taint was false.
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
      let ownerIsResettingTrust = false;
      if (ctx.senderIsOwner === true) {
        const resetMatch = peekContent.trim().match(
          /\.reset-trust(?:\s+(trusted|shared|external|untrusted))?(?:\s|$)/i,
        );
        if (resetMatch) {
          const targetLevel = (resetMatch[1]?.toLowerCase() ?? "trusted") as TrustLevel;
          ownerIsResettingTrust = true;
          // Execute the reset NOW — clear watermark, approvals, blocked tools
          graph.resetTaint(targetLevel);
          blockedToolsBySession.delete(sessionKey);
          approvalStore.clearAll(sessionKey);
          watermarkStore.clear(sessionKey);
          watermarkStore.flush();
          const sk = shortKey(sessionKey);
          logger.info(
            `[provenance:${sk}] 🔄 TRUST_RESET (early): → ${targetLevel} by owner command .reset-trust. Watermark cleared, approvals cleared, blocked tools cleared.`,
          );
        }
      }

      // Inherit taint watermark from previous turns (same-session)
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

      // Inherit taint from parent session (cross-session propagation).
      // When a tainted parent spawns a subagent, the child must inherit
      // the parent's taint to prevent taint laundering.
      if (ctx.spawnedBy && !ownerIsResettingTrust) {
        // Check parent's persisted watermark (completed previous turns)
        const parentWm = watermarkStore.getLevel(ctx.spawnedBy);
        // Check parent's active graph (current in-flight turn — the parent's
        // before_response_emit hasn't fired yet, so its watermark hasn't
        // been flushed for the current turn)
        const parentGraph = store.getActive(ctx.spawnedBy);
        let parentTaint: TrustLevel = "trusted";
        if (parentWm) parentTaint = minTrust(parentTaint, parentWm.level);
        if (parentGraph) parentTaint = minTrust(parentTaint, parentGraph.maxTaint);

        if (parentTaint !== "trusted") {
          const parentSk = shortKey(ctx.spawnedBy);
          graph.addNode({
            id: "inherited-parent-taint",
            kind: "history",
            trust: parentTaint,
            metadata: {
              reason: `inherited from parent (${parentSk})`,
              parentSessionKey: ctx.spawnedBy,
              parentWatermarkLevel: parentWm?.level,
              parentGraphTaint: parentGraph?.maxTaint,
            },
          });
          // Pre-seed the child's watermark so taint persists across
          // the subagent's own multi-turn interactions
          watermarkStore.escalate(
            sessionKey,
            parentTaint,
            `inherited from parent (${parentSk})`,
            `parent taint inheritance`,
          );
          logger.info(
            `[provenance:${shortKey(sessionKey)}]   PARENT_TAINT_INHERITANCE: ${parentTaint} from parent=${parentSk} (parentWatermark=${parentWm?.level ?? "none"}, parentActiveGraph=${parentGraph?.maxTaint ?? "none"}). Child watermark pre-seeded.`,
          );
        }
      }

      const sk = shortKey(sessionKey);
      const effectiveTaint = graph.maxTaint;

      // Capture turn-start taint for developerMode header
      const startReason = watermark && watermark.level !== "trusted"
        ? watermark.reason
        : `sender: ${ctx.senderName ?? ctx.senderId ?? "unknown"}`;
      turnStartTaintBySession.set(sessionKey, { level: effectiveTaint, reason: startReason });

      logger.info(`[provenance:${sk}] ── Turn Start ──`);
      logger.info(
        `[provenance:${sk}]   Messages: ${event.messageCount ?? 0} | System prompt: ${(event.systemPrompt ?? "").length} chars`,
      );
      logger.info(
        `[provenance:${sk}]   CLASSIFY_INITIAL_TRUST: ${initialTrust} | sender=${ctx.senderName ?? ctx.senderId ?? "unknown"} owner=${ctx.senderIsOwner ?? "unset"} group=${ctx.groupId ?? "none"} provider=${ctx.messageProvider ?? "none"}${ctx.sourceProvider ? ` sourceProvider=${ctx.sourceProvider}` : ""} effectiveProvider=${ctx.sourceProvider ?? ctx.messageProvider ?? "none"}`,
      );
      if (watermark && !ownerIsResettingTrust) {
        const wmIdx = TRUST_ORDER.indexOf(watermark.level);
        const initIdx = TRUST_ORDER.indexOf(initialTrust);
        if (wmIdx > initIdx) {
          logger.info(
            `[provenance:${sk}]   WATERMARK_INHERITANCE: watermark ${watermark.level} > initial ${initialTrust} → inherited-taint node added. Watermark reason: ${watermark.reason ?? "none"}`,
          );
        } else {
          logger.info(
            `[provenance:${sk}]   WATERMARK_SKIPPED: watermark ${watermark.level} ≤ initial ${initialTrust} → no inheritance needed`,
          );
        }
      } else if (watermark && ownerIsResettingTrust) {
        logger.info(
          `[provenance:${sk}]   WATERMARK_RESET_PENDING: watermark ${watermark.level} present but owner is resetting trust → skipped inheritance`,
        );
      }
      if (effectiveTaint !== initialTrust) {
        logger.info(
          `[provenance:${sk}]   TAINT_ESCALATED_AT_START: ${initialTrust} → ${effectiveTaint} (graph maxTaint after all inheritance nodes)`,
        );
      } else {
        logger.info(
          `[provenance:${sk}]   TAINT_AT_START: ${effectiveTaint}`,
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
        // NOTE: The actual reset is executed early in context_assembled for
        // atomicity (reported taint = actual taint). This block is a safety
        // net — if context_assembled didn't fire or missed the command, we
        // still execute it here.
        const resetMatch = trimmed.match(/\.reset-trust(?:\s+(trusted|shared|external|untrusted))?(?:\s|$)/i);
        if (resetMatch) {
          const targetLevel = (resetMatch[1]?.toLowerCase() ??
            "trusted") as TrustLevel;
          // Check if already handled by early reset
          const alreadyCleared = !watermarkStore.getLevel(sessionKey);
          if (alreadyCleared) {
            logger.info(
              `[provenance:${sk}] 🔄 TRUST_RESET (confirmed): already executed in context_assembled → ${targetLevel}`,
            );
          } else {
            // Safety net: execute reset here if early reset missed it
            const previousTaint = graph.maxTaint;
            graph.resetTaint(targetLevel);
            blockedToolsBySession.delete(sessionKey);
            approvalStore.clearAll(sessionKey);
            watermarkStore.clear(sessionKey);
            watermarkStore.flush();
            logger.warn(
              `[provenance:${sk}] 🔄 TRUST_RESET (late fallback): ${previousTaint} → ${targetLevel} by owner command .reset-trust. Watermark cleared. This should have been handled in context_assembled.`,
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
      // Build taint introspection line for system prompt injection.
      // This lets the LLM see its own security state — critical for correct reasoning
      // about what tools are available and why some may be blocked.
      const currentTaint = graph.maxTaint;
      const taintEmoji = currentTaint === "trusted" ? "🟢"
        : currentTaint === "shared" ? "🟡"
        : currentTaint === "external" ? "🟠"
        : "🔴";
      const currentWm = watermarkStore.getLevel(sessionKey);
      const wmInfo = currentWm && currentWm.level !== "trusted"
        ? ` | watermark: ${currentWm.level} (${currentWm.reason ?? "unknown"})`
        : "";
      const resetHint = currentTaint !== "trusted"
        ? " | Owner can use .reset-trust to clear."
        : "";
      const taintIntrospection = `\n[Security] ${taintEmoji} Taint: ${currentTaint}${wmInfo}${resetHint}`;
      const systemPromptWithTaint = (event.systemPrompt ?? "") + taintIntrospection;

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
        return { systemPrompt: systemPromptWithTaint };
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
        return { tools: allowedTools, systemPrompt: systemPromptWithTaint };
      } else {
        blockedToolsBySession.delete(sessionKey);
      }

      return { systemPrompt: systemPromptWithTaint };
    }),
  );

  // --- before_tool_call --- (EXECUTION-LAYER ENFORCEMENT)
  api.on(
    "before_tool_call",
    profiled("before_tool_call", (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      lastToolCallSessionKey = sessionKey;
      const sk = shortKey(sessionKey);
      const graph = store.getActive(sessionKey);
      const toolName = event.toolName;
      const toolNameLower = toolName.toLowerCase();

      // developerMode: inject taint header into outbound message tool sends
      if (developerMode && toolNameLower === "message" && event.params?.action === "send" && event.params?.message) {
        const graph = store.getActive(sessionKey);
        const watermark = watermarkStore.getLevel(sessionKey);
        const taintLevel = graph?.maxTaint ?? watermark?.level ?? "trusted";
        const taintReason = graph
          ? buildTaintReason(graph, watermark?.reason)
          : watermark?.reason ?? "unknown";

        const turnStart = turnStartTaintBySession.get(sessionKey);
        const startLevel = turnStart?.level ?? "trusted";
        const startReason = turnStart?.reason ?? "unknown";
        const lastImpacted = lastImpactedToolBySession.get(sessionKey) ?? "none";

        const taintEmoji = (level: string) =>
          level === "trusted" ? "🟢"
            : level === "shared" ? "🟡"
              : level === "external" ? "🟠"
                : "🔴";

        const footer = `\`${taintEmoji(startLevel)} ${startLevel} (${truncate(startReason, 60)}) → ${taintEmoji(taintLevel)} ${taintLevel} (${truncate(taintReason, 60)}) | impacted: ${lastImpacted}\``;
        return {
          params: { ...event.params, message: event.params.message + "\n" + footer },
        };
      }

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
      // Core sends tool calls with `arguments` (from LLM response); normalize to `params` for internal use
      const rawToolCalls: Array<{ name: string; params?: Record<string, unknown>; arguments?: Record<string, unknown> }> =
        event.toolCalls ?? [];
      const toolCalls = rawToolCalls.map(tc => ({
        name: tc.name,
        params: tc.params ?? tc.arguments ?? {},
      }));

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

        // Defer taint for browser content tools with unresolvable URIs.
        // When the URL isn't known at call time (no targetUrl param, and
        // targetId absent or can't be resolved via tab URL map), defer to
        // the current graph taint. after_tool_call will classify the actual
        // URL from the tool result and escalate if needed.
        if (sourceUris.length === 0 && BROWSER_DEFERRED_TOOLS.has(toolKey)) {
          effectiveTrust = graph.maxTaint;
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
      const previousTaintForLog = (graph as any).__lastLoggedTaint ?? graph.maxTaint;
      // Track taint before tool processing to detect escalation
      const taintBefore = toolCalls.length > 0 ? previousTaintForLog : graph.maxTaint;

      logger.info(
        `[provenance:${sk}] ── LLM Response (iteration ${event.iteration ?? 0}) ──`,
      );
      logger.info(
        `[provenance:${sk}]   Tool calls: ${toolDescriptions.length > 0 ? toolDescriptions.join(", ") : "(none)"}`,
      );
      if (graph.maxTaint !== taintBefore && toolCalls.length > 0) {
        // Identify which tool(s) caused the escalation
        const escalatingTools = toolCalls
          .map((tc: any) => {
            const params = tc.params ?? {};
            const toolKey = resolveToolKey(tc.name, params, compositeTools);
            const toolTrust = getToolTrust(toolKey, effectiveToolTaints);
            return { toolKey, toolTrust };
          })
          .filter(({ toolTrust }) => TRUST_ORDER.indexOf(toolTrust) > TRUST_ORDER.indexOf(taintBefore));
        const escalators = escalatingTools.map(t => `${t.toolKey}(${t.toolTrust})`).join(", ");
        logger.info(
          `[provenance:${sk}]   TOOL_TAINT_ESCALATION: ${taintBefore} → ${graph.maxTaint} caused by: ${escalators || "(indirect)"}`,
        );
      } else {
        logger.info(
          `[provenance:${sk}]   Taint after: ${graph.maxTaint}`,
        );
      }
      (graph as any).__lastLoggedTaint = graph.maxTaint;
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

        const wmBefore = currentWatermark?.level ?? "none";
        const wmAfter = watermarkStore.getLevel(sessionKey)?.level ?? "none";

        logger.info(`[provenance:${sk}] ── Turn Complete ──`);
        logger.info(
          `[provenance:${sk}]   Final taint: ${summary.maxTaint}`,
        );
        if (summary.maxTaint !== "trusted" || wmBefore !== "none") {
          logger.info(
            `[provenance:${sk}]   WATERMARK_UPDATE: ${wmBefore} → ${wmAfter} (turn maxTaint=${summary.maxTaint}, reason: ${wmReason})`,
          );
        }
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
          const taintEmoji = (level: string) =>
            level === "trusted"
              ? "🟢"
              : level === "shared"
                ? "🟡"
                : level === "external"
                  ? "🟠"
                  : "🔴";
          // Turn start taint
          const turnStart = turnStartTaintBySession.get(sessionKey);
          const startLevel = turnStart?.level ?? "trusted";
          const startReason = turnStart?.reason ?? "unknown";
          // Include URI sources in header if available
          const uriSummary = uriTaintRecords
            .filter((r) => r.effectiveTrust !== "trusted")
            .map((r) => `${r.tool}(${truncate(r.uri, 40)})`)
            .slice(0, 3);
          const uriPart = uriSummary.length > 0 ? ` | sources: ${uriSummary.join(", ")}` : "";
          const footer = `\`${taintEmoji(startLevel)} ${startLevel} (${truncate(startReason, 60)}) → ${taintEmoji(taintLevel)} ${taintLevel} (${truncate(taintReason, 60)}) | impacted: ${lastImpacted}${uriPart}\``;
          return { content: event.content + "\n" + footer };
        }
      },
    ),
  );

  // --- after_tool_call ---
  // Update browser tab URL map from actual tool results.
  // This ensures URI trust classification uses the CURRENT page URL,
  // not stale data from a prior browser.tabs call.
  api.on(
    "after_tool_call",
    profiled("after_tool_call", (event: any, _ctx: any) => {
      const toolName = event.toolName;
      const params = event.params ?? {};
      const result = event.result;

      if (!result || typeof result !== "object") return;

      const toolKey = resolveToolKey(toolName, params, compositeTools);

      // browser.tabs: seed tab URL map from response
      if (toolKey === "browser.tabs") {
        const content = Array.isArray((result as any).content) ? (result as any).content : [];
        for (const part of content) {
          if (part?.type === "text" && typeof part.text === "string") {
            const raw = part.text;
            if (!raw.includes('"tabs"')) continue;
            // Content may be wrapped in EXTERNAL_UNTRUSTED_CONTENT markers —
            // try raw first, then extract the JSON object between first { and last }
            const candidates = [
              raw,
              raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
            ];
            for (const candidate of candidates) {
              if (!candidate) continue;
              try {
                const obj = JSON.parse(candidate);
                if (obj?.tabs && Array.isArray(obj.tabs)) {
                  recordTabUrls(obj.tabs);
                  break;
                }
              } catch {
                // Try next candidate
              }
            }
          }
        }
      }

      // browser.snapshot/screenshot/console/pdf: extract URL from result and reclassify.
      // Handle both resolved composite keys (browser.snapshot) and bare tool name
      // (browser — when params.action is missing from after_tool_call event).
      const isBrowserContentResult =
        (toolKey.startsWith("browser.") && toolKey !== "browser.tabs") ||
        (toolName.toLowerCase() === "browser" && toolKey === toolName);

      if (isBrowserContentResult) {
        // Extract URL from result — try multiple locations:
        //   1. result.details (structured response extension)
        //   2. content[].text JSON (MCP standard format — URL embedded in response body)
        let url: string | undefined;
        let resolvedTargetId: string | undefined;

        const details = (result as any).details;
        if (typeof details?.url === "string") {
          url = details.url;
          resolvedTargetId = details.targetId ?? params.targetId;
        }

        if (!url) {
          const content = Array.isArray((result as any).content) ? (result as any).content : [];
          for (const part of content) {
            if (part?.type === "text" && typeof part.text === "string") {
              const raw = part.text;
              if (!raw.includes('"url"')) continue;
              const candidates = [
                raw,
                raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
              ];
              for (const candidate of candidates) {
                if (!candidate) continue;
                try {
                  const parsed = JSON.parse(candidate);
                  if (typeof parsed?.url === "string") {
                    url = parsed.url;
                    resolvedTargetId = parsed?.targetId ?? params.targetId;
                    break;
                  }
                  if (typeof parsed?.details?.url === "string") {
                    url = parsed.details.url;
                    resolvedTargetId = parsed?.details?.targetId ?? params.targetId;
                    break;
                  }
                } catch { /* try next candidate */ }
              }
              if (url) break;
            }
          }
        }

        // Use the composite key if resolved, otherwise fall back to a
        // representative deferred key for trust lookups
        const effectiveKey = BROWSER_DEFERRED_TOOLS.has(toolKey) ? toolKey
          : toolKey.startsWith("browser.") ? toolKey
          : "browser.snapshot";

        if (typeof url === "string") {
          // Update tab map if we have both URL and targetId
          if (typeof resolvedTargetId === "string") {
            recordTabUrls([{ targetId: resolvedTargetId, url }]);
          }

          // Re-classify: compare actual URL trust against current graph taint
          const sessionKey = _ctx.sessionKey ?? lastToolCallSessionKey;
          const graph = store.getActive(sessionKey);
          if (graph) {
            const agentId = sessionAgentMap.get(sessionKey);
            const effectiveUriTrustConfig = getUriTrustConfig(agentId);
            const uriTrust = classifyUri(url, effectiveUriTrustConfig);
            const effectiveToolTaints = getResolvedToolTaints(agentId);
            const toolTrust = getToolTrust(effectiveKey, effectiveToolTaints);
            const effectiveTrust = uriTrust ?? toolTrust;

            // If the actual URL yields worse trust than what was recorded,
            // escalate the graph to reflect reality
            const currentMax = TRUST_ORDER.indexOf(graph.maxTaint);
            const actualIdx = TRUST_ORDER.indexOf(effectiveTrust);
            if (actualIdx > currentMax) {
              const sk = shortKey(sessionKey);
              logger.warn(
                `[provenance:${sk}]   BROWSER_URL_RECLASSIFICATION: ${resolvedTargetId ? `tab ${shortKey(resolvedTargetId)}` : "browser"} on ${truncate(url, 60)} → trust ${effectiveTrust}. Escalating taint.`,
              );
              graph.recordToolCall(
                effectiveKey,
                0, // iteration unknown at this point
                undefined,
                effectiveToolTaints,
                { sourceUris: [url], effectiveTrust },
              );
            } else if (uriTrust !== undefined) {
              const sk = shortKey(sessionKey);
              logger.info(
                `[provenance:${sk}]   BROWSER_URI_RESOLVED: ${effectiveKey} on ${truncate(url, 60)} → trust ${effectiveTrust} (graph at ${graph.maxTaint})`,
              );
            }
          }
        } else if (BROWSER_DEFERRED_TOOLS.has(toolKey) || toolName.toLowerCase() === "browser") {
          // Safety net: a deferred browser content tool completed but the
          // result didn't include a resolvable URL. Apply the tool's default
          // output taint so external content doesn't silently enter context
          // at the deferred (optimistic) trust level.
          const sessionKey = _ctx.sessionKey ?? lastToolCallSessionKey;
          const graph = store.getActive(sessionKey);
          if (graph) {
            const agentId = sessionAgentMap.get(sessionKey);
            const effectiveToolTaints = getResolvedToolTaints(agentId);
            const toolTrust = getToolTrust(effectiveKey, effectiveToolTaints);
            const currentMaxIdx = TRUST_ORDER.indexOf(graph.maxTaint);
            const toolTrustIdx = TRUST_ORDER.indexOf(toolTrust);
            if (toolTrustIdx > currentMaxIdx) {
              const sk = shortKey(sessionKey);
              logger.warn(
                `[provenance:${sk}]   BROWSER_DEFERRED_FALLBACK: ${effectiveKey} completed but URL unresolvable from result — applying default tool taint ${toolTrust}`,
              );
              graph.recordToolCall(effectiveKey, 0, undefined, effectiveToolTaints, {
                sourceUris: [],
                effectiveTrust: toolTrust,
              });
            }
          }
        }
      }
    }),
  );

  return { store, approvalStore };
}
