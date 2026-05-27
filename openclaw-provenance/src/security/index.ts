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
import { getSharedWatermarkStore, WatermarkStore } from "./watermark-store.js";
import { getSharedIdentityStore, type IdentityStore } from "./identity-store.js";
import {
  createInboundClaimHandler,
  createSubagentSpawnedHandler,
} from "./inbound-handlers.js";
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
  buildExecCommandRules,
  type ExecCommandRule,
  type ExecCommandRuleConfig,
} from "./exec-command-taint.js";
import {
  buildUriTrustConfig,
  classifyUri,
  classifyUris,
  type UriTrustConfig,
} from "./uri-trust.js";
import type { UriTaintRecord } from "./watermark-store.js";
import {
  readProvenanceConfig,
  writeProvenanceConfig,
  deleteProvenanceConfigKeys,
} from "./config-writer.js";

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
  /** Additional exec command taint rules (prepended to built-in defaults) */
  execCommandRules?: ExecCommandRuleConfig[];
  /**
   * Sender IDs treated as the agent's owner. Used to compute
   * `senderIsOwner` from `inbound_claim` events when caching identity.
   *
   * Mainline does not surface owner classification on the agent
   * hookCtx, so provenance derives it itself from the inbound
   * sender id and this list. If empty/undefined, no senders are
   * classified as owner and owner-only commands silently no-op.
   */
  ownerNumbers?: string[];
}

/** Browser composite keys whose results may contain URL metadata for tab tracking. */
const BROWSER_CONTENT_TOOLS = new Set([
  "browser.snapshot",
  "browser.screenshot",
  "browser.console",
  "browser.pdf",
  "browser.navigate",
  "browser.open",
]);

/** Thread/topic session markers used by OpenClaw channel plugins */
const THREAD_SESSION_MARKERS = [":thread:", ":topic:"];

/**
 * Resolve the parent session key from a thread-bound session key.
 * E.g., "agent:tank:slack:channel:abc:thread:123" → "agent:tank:slack:channel:abc"
 * Returns null if the session key is not a thread session.
 */
function resolveThreadParentSessionKey(sessionKey: string): string | null {
  const normalized = sessionKey.toLowerCase();
  let idx = -1;
  for (const marker of THREAD_SESSION_MARKERS) {
    const candidate = normalized.lastIndexOf(marker);
    if (candidate > idx) {
      idx = candidate;
    }
  }
  if (idx <= 0) return null;
  const parent = sessionKey.slice(0, idx).trim();
  return parent || null;
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
 * 1. System-source session (heartbeat, cron, exec-event, webchat) → trusted
 *    Detected via identity.sourceProvider, messageProvider, OR sessionKey suffix.
 *    The sessionKey fallback is load-bearing: when core dispatches a heartbeat
 *    turn without populating identity.sourceProvider, the suffix is the only
 *    reliable signal that the turn isn't user-driven. Without this, the
 *    history node gets seeded with missingIdentityTrust (default "shared"),
 *    the graph's maxTaint clamps there, and an interrupted heartbeat turn
 *    silently escalates the session watermark.
 * 2. Sub-agent session (spawnedBy set) → trusted
 * 3. Owner (senderIsOwner=true) → trusted
 * 4. Trusted sender (senderId in trustedSenderIds) → trusted
 * 5. Known non-owner sender → external
 * 6. Unknown sender → untrusted
 */
const SYSTEM_SOURCE_PROVIDERS = new Set([
  "heartbeat",
  "cron",
  "cron-event",
  "exec-event",
  "webchat",
]);

const SYSTEM_SOURCE_SESSION_SUFFIXES = [
  ":heartbeat",
  ":cron",
  ":cron-event",
  ":exec-event",
];

/**
 * True if a session is system-source (heartbeat/cron/exec-event/webchat),
 * detected via identity.sourceProvider, messageProvider, OR sessionKey
 * suffix. Used by before_prompt_build and the seal handler to suppress
 * watermark inheritance and watermark escalation for these sessions.
 *
 * Rationale: heartbeat/cron turns are system-generated, never user-driven.
 * Their watermarks should not accumulate across runs; any non-trusted
 * watermark on such a session is by definition stale (e.g. left over from
 * a previous bug where the initial-trust classifier returned "shared" for
 * heartbeat sessions because identity.sourceProvider wasn't populated).
 * Without this gate, watermark inheritance in before_prompt_build feeds
 * the next heartbeat turn's graph an untrusted node, which the seal
 * handler then re-escalates — a self-perpetuating loop that survives
 * even after /reset-trust unless every interrupted heartbeat turn is
 * also drained before the next one starts.
 */
function isSystemSourceSession(params: {
  identity?: import("./identity-store.js").IdentityRecord;
  messageProvider?: string;
  sessionKey?: string;
}): boolean {
  const effectiveProvider = params.identity?.sourceProvider ?? params.messageProvider;
  if (effectiveProvider && SYSTEM_SOURCE_PROVIDERS.has(effectiveProvider)) {
    return true;
  }
  if (
    params.sessionKey &&
    SYSTEM_SOURCE_SESSION_SUFFIXES.some((s) => params.sessionKey!.endsWith(s))
  ) {
    return true;
  }
  return false;
}

function classifyInitialTrust(params: {
  identity?: import("./identity-store.js").IdentityRecord;
  messageProvider?: string;
  trustedSenderIds: Set<string>;
  missingIdentityTrust?: TrustLevel;
  sessionKey?: string;
}): TrustLevel {
  const { identity, messageProvider, trustedSenderIds, sessionKey } = params;
  const missingIdentityTrust = params.missingIdentityTrust ?? "shared";
  const effectiveProvider = identity?.sourceProvider ?? messageProvider;
  if (!effectiveProvider || SYSTEM_SOURCE_PROVIDERS.has(effectiveProvider)) {
    return "trusted";
  }
  if (sessionKey && SYSTEM_SOURCE_SESSION_SUFFIXES.some((s) => sessionKey.endsWith(s))) {
    return "trusted";
  }

  if (identity?.spawnedBy) {
    return "trusted";
  }

  if (identity?.senderIsOwner) {
    return "trusted";
  }

  if (identity?.senderId && trustedSenderIds.has(identity.senderId)) {
    return "trusted";
  }

  if (identity?.senderId) {
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
function isOwnerDm(
  identity: import("./identity-store.js").IdentityRecord | undefined,
): boolean {
  if (!identity) return false;
  return identity.senderIsOwner === true && !identity.groupId && !identity.spawnedBy;
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

// =============================================================================
// PROCESS-GLOBAL PER-SESSION STATE
// =============================================================================
//
// Some maps must be PROCESS-GLOBAL (anchored on globalThis), not
// function-scoped, NOR even merely module-scoped, because:
//
//   1. `registerSecurityHooks` is invoked multiple times during a gateway
//      lifetime (once per agent context: tank, narcissus, shiva, smith,
//      main, ...). Function-scoped state means each closure has its own
//      copy.
//
//   2. The plugin module itself can be loaded more than once in a single
//      Node process. Different agent runtime contexts and different hook
//      runners can resolve and `require`/`import` the plugin from
//      independent paths (CommonJS+ESM, agent-scoped node_modules, etc.),
//      each yielding a fresh module instance with its own top-level state.
//      Plain module scope is NOT sufficient.
//
// The empirical evidence captured in the gateway log on 2026-04-28 showed:
//   agent_end SET    fullKey=agent:tank:discord:tank:direct:1594  mapInstance=d3j2d7fe
//   message_sending  sessionKey=agent:tank:discord:tank:direct:1594 lookupHit=false mapInstance=amk32ibv
//   message_sending  sessionKey=agent:tank:discord:tank:direct:1594 lookupHit=true  mapInstance=d3j2d7fe
// confirming the cross-instance leak even after the maps were promoted to
// module scope. Anchoring the state on globalThis fixes both layers in one
// step — every plugin instance in the same process points at the same Map.
//
// Maps that MUST be shared (read/written across hooks that can land on
// different instances during one delivery):
//   - blockedToolsBySession      (before_tool_call → agent_end clear)
// Maps that can stay function-scoped (read+written only inside one instance's
// own hook chain): turnStartTimes, lastLlmNodeBySession, sessionAgentMap.

type ProvenanceProcessState = {
  blockedToolsBySession: Map<string, Set<string>>;
  /** Bumped each time the module is evaluated; used to detect duplicate loads. */
  moduleLoadCount: number;
};

const PROVENANCE_GLOBAL_KEY = Symbol.for(
  "openclaw.provenance.processState.v1",
);

function getProcessState(): ProvenanceProcessState {
  const g = globalThis as unknown as Record<symbol, ProvenanceProcessState | undefined>;
  let state = g[PROVENANCE_GLOBAL_KEY];
  if (!state) {
    state = {
      blockedToolsBySession: new Map<string, Set<string>>(),
      moduleLoadCount: 0,
    };
    g[PROVENANCE_GLOBAL_KEY] = state;
  }
  state.moduleLoadCount += 1;
  return state;
}

const __provenanceProcessState = getProcessState();
const blockedToolsBySession = __provenanceProcessState.blockedToolsBySession;

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
  // Mutable: hot-reloaded by /trust-uri and /trust-tool commands
  let resolvedToolTaints = buildToolOutputTaintMap(mergedToolOutputTaintOverrides);
  const verbose = config?.verbose ?? false;

  // Build composite tools, URI extractors, and URI trust config
  const compositeTools = buildCompositeToolMap(config?.compositeTools);
  const uriExtractors = buildUriExtractorMap(config?.uriExtractors);
  const execCommandRules = buildExecCommandRules(config?.execCommandRules);
  const workspaceDir = config?.workspaceDir ?? process.cwd();
  // Mutable: hot-reloaded by /trust-uri command
  let defaultUriTrustConfig = buildUriTrustConfig(config?.uriTrust, workspaceDir);
  const trustedSenderIds = new Set(config?.trustedSenderIds ?? []);

  const resolvedMissingIdentityTrust = config?.missingIdentityTrust ?? "shared";
  logger.info(
    `[provenance] missingIdentityTrust: ${resolvedMissingIdentityTrust}${config?.missingIdentityTrust ? " (from config)" : " (default)"}`,
  );

  // Use shared singleton so all agent plugin instances see the same state.
  // Without this, each agent (main, tank, narcissus, etc.) would have an
  // independent in-memory view of the same JSON file, causing /reset-trust
  // to only clear the calling agent's view while others overwrite on flush.
  const watermarkStore = getSharedWatermarkStore(workspaceDir);
  logger.info(
    `[provenance] Watermark store: ${workspaceDir}/.provenance/watermarks.json`,
  );

  // Identity store: caches per-session sender/owner/group/spawn data so
  // that agent-loop hooks (before_prompt_build, llm_output, etc.) can
  // look up identity by sessionKey instead of relying on agent hookCtx
  // fields that mainline does not populate. Persisted to disk for
  // continuity across gateway restarts.
  const identityStore = getSharedIdentityStore(workspaceDir);
  const ownerNumbers = (config?.ownerNumbers ?? []) as readonly string[];
  logger.info(
    `[provenance] Identity store: ${workspaceDir}/.provenance/identity.json | ` +
      `ownerNumbers configured: ${ownerNumbers.length}`,
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
  // Mutable: hot-reloaded by /trust-tool command
  let defaultPolicyConfig = buildPolicyConfig(
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
  if (Object.keys(agentOverrides).length > 0) {
    logger.info(
      `[provenance]   Agent overrides: ${Object.keys(agentOverrides).join(", ")}`,
    );
  }
  logger.info(
    `[provenance]   Composite tools: ${Object.keys(compositeTools).join(", ")}`,
  );
  logger.info(
    `[provenance]   Exec command rules: ${execCommandRules.length} patterns`,
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

  // Per-session state (instance-local maps that don't need cross-instance
  // sharing; the maps that DO need sharing are declared at module scope above).
  const lastLlmNodeBySession = new Map<string, string>();
  // (lastProcessedMessageCount removed — .approve replaced by /approve-exec command)
  const sessionAgentMap = new Map<string, string>();
  // trustResetPendingBySession and trustResetRunIdBySession removed —
  // .reset-trust is now handled exclusively via /reset-trust plugin command
  // (pre-agent-loop, deterministic). No mid-loop interception needed.
  /** Cached owner-DM status per session, set in context_assembled for use in after_tool_call
   *  (which lacks the senderIsOwner/groupId/spawnedBy fields on its context). */
  const sessionOwnerDmMap = new Map<string, boolean>();

  /**
   * Sessions that have been reset via /new or /reset but whose watermark
   * has not yet been cleared (because before_reset fires async and may
   * race context_assembled). context_assembled checks this set and clears
   * the watermark before inheriting it, then removes the entry.
   */
  const resetPendingSessions = new Set<string>();

  // --- /reset-trust command (registered as plugin command — fires pre-agent-loop) ---
  // Authoritative, deterministic reset path. Runs BEFORE the agent event loop,
  // clears all taint state atomically, and returns a fixed response string.
  // No LLM call is made. Use /reset-trust [level] where level is one of:
  //   trusted (default) | shared | external | untrusted

  /**
   * Derive a session key from PluginCommandContext.
   *
   * Plugin commands don't receive sessionKey directly (it's only on AgentContext),
   * so we reconstruct it from the available context fields using the same logic
   * OpenClaw uses for agent sessions.
   *
   * `from` field format: <channel>:<peerKind>:<peerId> (e.g., "slack:channel:C0AG45JJ1E1")
   * Session key format: agent:<agentId>:<from>[:thread:<threadId>]
   */
  function deriveSessionKeyFromCommandContext(ctx: any): string | null {
    // `from` contains the full routing path: <channel>:<peerKind>:<peerId>
    // e.g., "slack:channel:C0AG45JJ1E1" or "discord:channel:1234567890"
    const from = ((ctx.from ?? ctx.to ?? "") as string).trim().toLowerCase();
    if (!from) {
      return null;
    }

    // Use agentId from context if available; plugin commands often lack it, fall back to "main".
    // Without this, /reset-trust run in an agent session (e.g. tank) derives
    // agent:main:... instead of agent:tank:... and clears the wrong key.
    const agentId = ((ctx.agentId ?? ctx.agent?.id ?? "main") as string).toLowerCase().trim() || "main";

    // Build base session key: agent:<agentId>:<from>
    let sessionKey = `agent:${agentId}:${from}`;

    // Add thread suffix if present
    const threadId = ctx.messageThreadId;
    if (threadId != null && threadId !== "") {
      const normalizedThreadId = String(threadId).trim().toLowerCase();
      if (normalizedThreadId) {
        sessionKey = `${sessionKey}:thread:${normalizedThreadId}`;
      }
    }

    return sessionKey;
  }

  api.registerCommand?.({
    name: "reset-trust",
    description: "Reset session taint to trusted baseline. Usage: /reset-trust [trusted|shared|external|untrusted]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const rawArgs = (ctx.args ?? "").trim().toLowerCase();
      const validLevels = ["trusted", "shared", "external", "untrusted"] as const;
      const targetLevel: TrustLevel = (validLevels as readonly string[]).includes(rawArgs)
        ? (rawArgs as TrustLevel)
        : "trusted";

      const allWatermarks = watermarkStore.listAll();
      const clearedSessions: string[] = [];

      // Clear the current session (from ctx) even if it has no watermark yet,
      // so that /reset-trust always resets the calling session.
      // Try multiple sources: explicit sessionKey, session object, or derive from context.
      const callerSessionKey = (
        ctx.sessionKey ??
        ctx.session?.key ??
        deriveSessionKeyFromCommandContext(ctx) ??
        ""
      ) as string;

      logger.info(
        `[provenance] 🔄 TRUST_RESET (command): callerSessionKey=${callerSessionKey || "(empty)"}, ` +
        `channel=${ctx.channel ?? "(none)"}, from=${ctx.from ?? "(none)"}, ` +
        `threadId=${ctx.messageThreadId ?? "(none)"}, allWatermarks=${Object.keys(allWatermarks).length}`,
      );

      const sessionsToClear = new Set([
        ...Object.keys(allWatermarks),
        ...(callerSessionKey ? [callerSessionKey] : []),
      ]);

      for (const sessionKey of sessionsToClear) {
        // Count what we ACTUALLY cleared, not what the pre-loop snapshot
        // captured. Without this, sessions whose watermark was added (or
        // /provenance-observable) between handler-start and this iteration
        // get cleared by watermarkStore.clear() but counted as 0 — leading
        // to "No active taint watermarks found" reports even though clearly
        // there was state to clean. Reading the live store via .get()
        // immediately before clear() makes the count match reality.
        const liveEntry = watermarkStore.get(sessionKey);
        const priorLevel = liveEntry?.level ?? allWatermarks[sessionKey]?.level;
        const hadActiveGraph = store.getActive(sessionKey) !== undefined;
        watermarkStore.clear(sessionKey);
        blockedToolsBySession.delete(sessionKey);
        approvalStore.clearAll(sessionKey);
        // Discard any pending-but-unsealed active graph so its maxTaint
        // doesn't re-escalate the watermark on the next turn via the
        // SEALED_PREVIOUS_ESCALATION path in startTurn.
        store.discardActive(sessionKey);
        // Only count as "cleared" if there was actual state to clear.
        // Without this, running /reset-trust twice in a row still reports
        // "1 session cleared" even though nothing changed.
        if (priorLevel || hadActiveGraph) {
          clearedSessions.push(sessionKey);
        }
        logger.info(
          `[provenance:${shortKey(sessionKey)}] 🔄 TRUST_RESET (command): cleared watermark (was ${priorLevel ?? "none"}${hadActiveGraph ? ", discarded active graph" : ""}) → ${targetLevel}`,
        );
      }

      // If targetLevel is not trusted, re-escalate to that level so the
      // in-memory and on-disk state reflect the requested baseline.
      if (targetLevel !== "trusted") {
        for (const sessionKey of clearedSessions) {
          watermarkStore.escalate(
            sessionKey,
            targetLevel,
            `/reset-trust ${targetLevel}`,
            "reset-trust command",
          );
        }
      }

      watermarkStore.flush();

      const sessionCount = clearedSessions.length;
      const levelNote = targetLevel !== "trusted" ? ` (to ${targetLevel})` : "";
      const clearedNote = sessionCount > 0
        ? `${sessionCount} session${sessionCount > 1 ? "s" : ""} cleared${levelNote}.`
        : `No active taint watermarks found.`;

      logger.info(`[provenance] 🔄 TRUST_RESET (command): ${clearedNote}`);

      return {
        text: `✅ Trust reset. Session taint cleared to ${targetLevel}. ${clearedNote}`,
      };
    },
  });

  // --- /trust-status command (read-only inspector) ---
  // Lists every persisted watermark with level, reason, age, and reset count.
  // Optional arg filters by sessionKey substring match (e.g. "narcissus",
  // "agent:tank", "agent:narcissus:cron"). Output is grouped by agent id and
  // marks heartbeat keys explicitly.
  api.registerCommand?.({
    name: "trust-status",
    description:
      "Show persisted taint watermarks. Usage: /trust-status [agentOrPrefix]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const filter = ((ctx.args ?? "") as string).trim();
      const all = watermarkStore.listAll();
      const entries = Object.entries(all).filter(([key]) =>
        filter ? key.includes(filter) : true,
      );

      if (!entries.length) {
        return {
          text: filter
            ? `No taint watermarks match \`${filter}\`.`
            : "No taint watermarks set. All sessions start trusted.",
        };
      }

      // Group by agent id (first "agent:<id>:..." segment); fall back to
      // "(other)" for keys that don't follow the agent: prefix convention.
      const groups = new Map<string, Array<[string, any]>>();
      for (const [key, entry] of entries) {
        const m = key.match(/^agent:([^:]+):/);
        const agent = m ? m[1] : "(other)";
        if (!groups.has(agent)) groups.set(agent, []);
        groups.get(agent)!.push([key, entry]);
      }

      const now = Date.now();
      const fmtAge = (iso: string): string => {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return "?";
        const ms = Math.max(0, now - t);
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h${m % 60}m`;
        const d = Math.floor(h / 24);
        return `${d}d${h % 24}h`;
      };

      const levelEmoji: Record<string, string> = {
        trusted: "\ud83d\udfe2",
        shared: "\ud83d\udfe1",
        external: "\ud83d\udfe0",
        untrusted: "\ud83d\udd34",
      };

      const lines: string[] = [];
      lines.push(
        `Persisted taint watermarks (${entries.length} entr${entries.length === 1 ? "y" : "ies"}${filter ? `, filter: \`${filter}\`` : ""}):`,
      );
      lines.push("");

      const sortedAgents = Array.from(groups.keys()).sort();
      for (const agent of sortedAgents) {
        lines.push(`**${agent}**`);
        const items = groups.get(agent)!.sort(([a], [b]) => a.localeCompare(b));
        for (const [key, entry] of items) {
          const isHeartbeat = key.endsWith(":heartbeat");
          const tag = isHeartbeat ? " [heartbeat]" : "";
          const emoji = levelEmoji[entry.level] ?? "\u26aa";
          const age = fmtAge(entry.escalatedAt);
          const resetCount = Array.isArray(entry.resetHistory)
            ? entry.resetHistory.length
            : 0;
          const resetNote = resetCount > 0 ? ` resets=${resetCount}\u00b7` : "";
          lines.push(`  ${emoji} \`${key}\`${tag}`);
          lines.push(
            `      level=${entry.level} \u00b7 age=${age} \u00b7${resetNote} reason: ${entry.reason}`,
          );
        }
        lines.push("");
      }

      lines.push(
        "Clear specific keys with `/reset-trust-key <sessionKeyOrPrefix>` or all with `/reset-trust`.",
      );

      return { text: lines.join("\n") };
    },
  });

  // --- /reset-trust-key command (surgical clear) ---
  // Clears watermarks matching a literal sessionKey OR a substring/glob.
  // Mirrors the per-key sequence used by /reset-trust but limits the blast
  // radius. Refuses to silently include the caller's own session unless the
  // arg matches it exactly (so prefix typos don't nuke the live session).
  api.registerCommand?.({
    name: "reset-trust-key",
    description:
      "Clear taint watermarks for matching sessionKey(s). Usage: /reset-trust-key <sessionKeyOrPrefix>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const rawArg = ((ctx.args ?? "") as string).trim();
      if (!rawArg) {
        return {
          text:
            "Usage: `/reset-trust-key <sessionKeyOrPrefix>`\n" +
            "Examples:\n" +
            "  `/reset-trust-key agent:narcissus:main:heartbeat` \u2014 exact key\n" +
            "  `/reset-trust-key agent:narcissus` \u2014 every narcissus key\n" +
            "  `/reset-trust-key :heartbeat` \u2014 every heartbeat key across agents\n" +
            "Tip: list current keys with `/trust-status`.",
        };
      }

      const callerSessionKey = (
        ctx.sessionKey ??
        ctx.session?.key ??
        deriveSessionKeyFromCommandContext(ctx) ??
        ""
      ) as string;

      const all = watermarkStore.listAll();
      const allKeys = Object.keys(all);

      // Match strategy: exact key wins; otherwise substring (the simple
      // form covers prefix, suffix, and middle matches without needing a
      // glob parser).
      const exactMatch = allKeys.includes(rawArg) ? [rawArg] : [];
      const substringMatches = exactMatch.length
        ? exactMatch
        : allKeys.filter((k) => k.includes(rawArg));

      // Safety: don't sweep the caller's own session unless they typed it
      // exactly. Prevents `/reset-trust-key agent:tank` from clearing a
      // running tank session as a side effect.
      const matches = substringMatches.filter((k) => {
        if (!callerSessionKey || k !== callerSessionKey) return true;
        return rawArg === callerSessionKey;
      });
      const skippedSelf = substringMatches.length !== matches.length;

      if (!matches.length) {
        const note = skippedSelf
          ? " (caller session was the only match; pass the exact sessionKey to include it)"
          : "";
        return {
          text: `No watermarks match \`${rawArg}\`.${note}`,
        };
      }

      const cleared: Array<{ key: string; priorLevel: string }> = [];
      for (const key of matches) {
        const priorLevel = all[key]?.level ?? "unknown";
        watermarkStore.clear(key);
        blockedToolsBySession.delete(key);
        approvalStore.clearAll(key);
        store.discardActive(key);
        cleared.push({ key, priorLevel });
        logger.info(
          `[provenance:${shortKey(key)}] \ud83d\udd04 TRUST_RESET (key command): cleared watermark (was ${priorLevel}) \u2192 trusted`,
        );
      }
      watermarkStore.flush();

      const lines: string[] = [];
      lines.push(
        `\u2705 Cleared ${cleared.length} watermark${cleared.length === 1 ? "" : "s"}:`,
      );
      for (const c of cleared) {
        lines.push(`  \u2022 \`${c.key}\` (was ${c.priorLevel})`);
      }
      if (skippedSelf) {
        lines.push("");
        lines.push(
          `_Skipped caller session \`${callerSessionKey}\`; pass the full sessionKey to include it._`,
        );
      }
      return { text: lines.join("\n") };
    },
  });

  // --- /approve-exec command (deterministic, pre-loop approval — replaces .approve in LLM context) ---
  // Grants tool approval for the current session. Runs before the agent loop.
  // Usage: /approve-exec <tool|all> [session|<N>m|<N>h]
  //   session (default) = turn-scoped, cleared at turn end
  //   30m, 2h = time-bounded, persists until expiry
  api.registerCommand?.({
    name: "approve-exec",
    description:
      "Approve blocked tool(s) for the current session. Usage: /approve-exec <tool|all> [session|<N>m|<N>h]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const args = ((ctx.args ?? "") as string).trim();
      if (!args) {
        return {
          text:
            "Usage: `/approve-exec <tool|all> [session|<N>m|<N>h]`\n" +
            "Examples:\n" +
            "  `/approve-exec exec` — approve exec for this turn\n" +
            "  `/approve-exec all 30m` — approve all blocked tools for 30 minutes\n" +
            "  `/approve-exec web_fetch session` — approve web_fetch for this turn",
        };
      }

      const parts = args.split(/\s+/);
      const target = parts[0].toLowerCase();
      const durationArg = parts[1]?.toLowerCase() ?? "session";

      // Parse duration: "session" → null (turn-scoped), "30m" → 30, "2h" → 120, bare number → minutes
      let durationMinutes: number | null = null;
      if (durationArg && durationArg !== "session") {
        const mMatch = durationArg.match(/^(\d+)m$/);
        const hMatch = durationArg.match(/^(\d+)h$/);
        const numMatch = durationArg.match(/^(\d+)$/);
        if (mMatch) durationMinutes = parseInt(mMatch[1], 10);
        else if (hMatch) durationMinutes = parseInt(hMatch[1], 10) * 60;
        else if (numMatch) durationMinutes = parseInt(numMatch[1], 10); // backward compat
        else {
          return { text: `❌ Invalid duration "${durationArg}". Use session, 30m, 2h, etc.` };
        }
      }

      const callerSessionKey = (
        ctx.sessionKey ??
        ctx.session?.key ??
        deriveSessionKeyFromCommandContext(ctx) ??
        ""
      ) as string;

      if (!callerSessionKey) {
        return { text: "❌ Could not determine session. Please try again." };
      }

      const sk = shortKey(callerSessionKey);
      const durDesc = durationMinutes != null ? `${durationMinutes} minutes` : "this turn";

      if (target === "all") {
        const blocked = blockedToolsBySession.get(callerSessionKey);
        const blockedList = blocked && blocked.size > 0 ? Array.from(blocked) : [];
        approvalStore.approve(callerSessionKey, "all", durationMinutes);
        if (blockedList.length > 0) {
          approvalStore.approveMultiple(callerSessionKey, blockedList, durationMinutes);
          logger.info(
            `[provenance:${sk}] ✅ /approve-exec all: approved ${blockedList.join(", ")} (${durDesc})`,
          );
          return {
            text:
              `✅ Approved all blocked tools (${durDesc}):\n` +
              blockedList.map((t) => `  • ${t}`).join("\n"),
          };
        } else {
          logger.info(`[provenance:${sk}] ✅ /approve-exec all: wildcard set (${durDesc}), no currently blocked tools`);
          return { text: `✅ Wildcard approval set (${durDesc}). All tools approved going forward this session.` };
        }
      } else {
        approvalStore.approve(callerSessionKey, target, durationMinutes);
        logger.info(`[provenance:${sk}] ✅ /approve-exec ${target} (${durDesc})`);
        return { text: `✅ Approved \`${target}\` for ${durDesc}.` };
      }
    },
  });

  // --- /trust-uri command ---
  // Add, remove, or list URI trust patterns in openclaw.json (with hot-reload).
  // Usage:
  //   /trust-uri add <pattern> <trusted|shared|external|untrusted>
  //   /trust-uri remove <pattern>
  //   /trust-uri list
  api.registerCommand?.({
    name: "trust-uri",
    description:
      "Manage URI trust patterns. Usage: /trust-uri add <pattern> <level> | remove <pattern> | list",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const args = ((ctx.args ?? "") as string).trim();
      const parts = args.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase();

      const validLevels: TrustLevel[] = ["trusted", "shared", "external", "untrusted"];

      if (subcommand === "list") {
        const current = readProvenanceConfig();
        const patterns = current.uriTrust ?? {};
        const entries = Object.entries(patterns);
        if (entries.length === 0) {
          return { text: "No user-configured URI trust patterns. Using built-in defaults only." };
        }
        const lines = entries.map(([p, l]) => `  • \`${p}\` → **${l}**`).join("\n");
        return { text: `**URI trust patterns (user-configured):**\n${lines}` };
      }

      if (subcommand === "add") {
        const pattern = parts[1];
        const level = parts[2]?.toLowerCase() as TrustLevel | undefined;
        if (!pattern || !level) {
          return { text: "Usage: `/trust-uri add <pattern> <trusted|shared|external|untrusted>`" };
        }
        if (!validLevels.includes(level)) {
          return { text: `❌ Invalid trust level "${level}". Valid: ${validLevels.join(", ")}` };
        }
        // Validate the pattern compiles
        try {
          buildUriTrustConfig({ [pattern]: level }, workspaceDir);
        } catch (err) {
          return { text: `❌ Invalid URI pattern "${pattern}": ${String(err)}` };
        }

        try {
          const current = readProvenanceConfig();
          writeProvenanceConfig({
            uriTrust: { ...(current.uriTrust ?? {}), [pattern]: level },
          });
          // Hot-reload in-memory config
          const updated = readProvenanceConfig();
          defaultUriTrustConfig = buildUriTrustConfig(updated.uriTrust, workspaceDir);
          logger.info(`[provenance] /trust-uri add: "${pattern}" → ${level} (hot-reloaded)`);
          return { text: `✅ Added URI trust: \`${pattern}\` → **${level}**\nIn-memory config updated immediately.` };
        } catch (err) {
          return { text: `❌ Failed to write config: ${String(err)}` };
        }
      }

      if (subcommand === "remove") {
        const pattern = parts[1];
        if (!pattern) {
          return { text: "Usage: `/trust-uri remove <pattern>`" };
        }
        try {
          deleteProvenanceConfigKeys("uriTrust", [pattern]);
          // Hot-reload
          const updated = readProvenanceConfig();
          defaultUriTrustConfig = buildUriTrustConfig(updated.uriTrust, workspaceDir);
          logger.info(`[provenance] /trust-uri remove: "${pattern}" removed (hot-reloaded)`);
          return { text: `✅ Removed URI trust pattern: \`${pattern}\`\nIn-memory config updated immediately.` };
        } catch (err) {
          return { text: `❌ Failed to write config: ${String(err)}` };
        }
      }

      return {
        text:
          "Usage:\n" +
          "  `/trust-uri add <pattern> <trusted|shared|external|untrusted>`\n" +
          "  `/trust-uri remove <pattern>`\n" +
          "  `/trust-uri list`\n\n" +
          "Pattern examples:\n" +
          "  `https://internal.company.com/**` → trusted\n" +
          "  `https://api.github.com/**` → shared",
      };
    },
  });

  // --- /trust-tool command ---
  // Add, remove, or list tool trust overrides in openclaw.json (with hot-reload).
  // Usage:
  //   /trust-tool add <tool[.sub]> [--policy allow|restrict] [--output-taint <level>]
  //   /trust-tool remove <tool[.sub]> --policy | --output-taint | both
  //   /trust-tool list
  api.registerCommand?.({
    name: "trust-tool",
    description:
      "Manage tool trust overrides. Usage: /trust-tool add <tool> [--policy allow|restrict] [--output-taint <level>] | remove <tool> --policy|--output-taint | list",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const args = ((ctx.args ?? "") as string).trim();
      const parts = args.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase();

      const validLevels: TrustLevel[] = ["trusted", "shared", "external", "untrusted"];
      // "confirm" still accepted as legacy input (normalized to "restrict" on apply).
      const validModes: string[] = ["allow", "restrict", "confirm"];

      if (subcommand === "list") {
        const current = readProvenanceConfig();
        const lines: string[] = [];
        const overrides = current.toolOverrides ?? {};
        const outputTaints = current.toolOutputTaints ?? {};
        const allTools = new Set([...Object.keys(overrides), ...Object.keys(outputTaints)]);
        if (allTools.size === 0) {
          return { text: "No user-configured tool trust overrides. Using built-in defaults only." };
        }
        for (const tool of [...allTools].sort()) {
          const policyPart = overrides[tool]
            ? `policy: ${JSON.stringify(overrides[tool])}`
            : null;
          const taintPart = outputTaints[tool]
            ? `output-taint: ${outputTaints[tool]}`
            : null;
          lines.push(`  • \`${tool}\` — ${[policyPart, taintPart].filter(Boolean).join(", ")}`);
        }
        return { text: `**Tool trust overrides (user-configured):**\n${lines.join("\n")}` };
      }

      if (subcommand === "add") {
        const tool = parts[1]?.toLowerCase();
        if (!tool) {
          return {
            text:
              "Usage: `/trust-tool add <tool[.sub]> [--policy allow|restrict] [--output-taint <level>]`\n" +
              "At least one of --policy or --output-taint is required.",
          };
        }

        // Parse flags
        const policyIdx = parts.indexOf("--policy");
        const outputTaintIdx = parts.indexOf("--output-taint");
        const policyValue = policyIdx >= 0 ? parts[policyIdx + 1]?.toLowerCase() as PolicyMode : undefined;
        const outputTaintValue = outputTaintIdx >= 0 ? parts[outputTaintIdx + 1]?.toLowerCase() as TrustLevel : undefined;

        if (!policyValue && !outputTaintValue) {
          return { text: "❌ At least one of `--policy` or `--output-taint` is required." };
        }
        if (policyValue && !validModes.includes(policyValue)) {
          return { text: `❌ Invalid policy mode "${policyValue}". Valid: ${validModes.join(", ")}` };
        }
        if (outputTaintValue && !validLevels.includes(outputTaintValue)) {
          return { text: `❌ Invalid output taint "${outputTaintValue}". Valid: ${validLevels.join(", ")}` };
        }

        try {
          const current = readProvenanceConfig();
          const patch: Partial<typeof current> = {};

          if (policyValue) {
            patch.toolOverrides = {
              ...(current.toolOverrides ?? {}),
              [tool]: { ...(current.toolOverrides?.[tool] ?? {}), "*": policyValue },
            };
          }
          if (outputTaintValue) {
            patch.toolOutputTaints = {
              ...(current.toolOutputTaints ?? {}),
              [tool]: outputTaintValue,
            };
          }

          writeProvenanceConfig(patch);

          // Hot-reload in-memory configs
          const updated = readProvenanceConfig();
          if (outputTaintValue) {
            const mergedOutputTaints = {
              ...DEFAULT_COMPOSITE_OUTPUT_TAINTS,
              ...(toolOutputTaintOverrides ?? {}),
              ...(updated.toolOutputTaints ?? {}),
            };
            resolvedToolTaints = buildToolOutputTaintMap(mergedOutputTaints);
          }
          if (policyValue) {
            const mergedOverrides = {
              ...DEFAULT_COMPOSITE_TOOL_OVERRIDES,
              ...(config?.toolOverrides ?? {}),
              ...(updated.toolOverrides ?? {}),
            };
            defaultPolicyConfig = buildPolicyConfig(
              config?.taintPolicy as any,
              mergedOverrides,
              config?.maxIterations,
              logger,
            );
          }

          const parts2: string[] = [];
          if (policyValue) parts2.push(`policy: all taint levels → **${policyValue}**`);
          if (outputTaintValue) parts2.push(`output-taint: **${outputTaintValue}**`);
          logger.info(`[provenance] /trust-tool add: "${tool}" — ${parts2.join(", ")} (hot-reloaded)`);
          return {
            text:
              `✅ Tool trust updated: \`${tool}\`\n` +
              parts2.map((p) => `  • ${p}`).join("\n") +
              "\nIn-memory config updated immediately.",
          };
        } catch (err) {
          return { text: `❌ Failed to write config: ${String(err)}` };
        }
      }

      if (subcommand === "remove") {
        const tool = parts[1]?.toLowerCase();
        if (!tool) {
          return { text: "Usage: `/trust-tool remove <tool[.sub]> --policy | --output-taint`" };
        }

        const removePolicy = parts.includes("--policy");
        const removeOutputTaint = parts.includes("--output-taint");

        if (!removePolicy && !removeOutputTaint) {
          return {
            text:
              "❌ Specify what to remove:\n" +
              "  `--policy` — remove call policy override\n" +
              "  `--output-taint` — remove output taint override\n" +
              "  Both flags can be combined.",
          };
        }

        try {
          if (removePolicy) deleteProvenanceConfigKeys("toolOverrides", [tool]);
          if (removeOutputTaint) deleteProvenanceConfigKeys("toolOutputTaints", [tool]);

          // Hot-reload
          const updated = readProvenanceConfig();
          if (removeOutputTaint) {
            const mergedOutputTaints = {
              ...DEFAULT_COMPOSITE_OUTPUT_TAINTS,
              ...(toolOutputTaintOverrides ?? {}),
              ...(updated.toolOutputTaints ?? {}),
            };
            resolvedToolTaints = buildToolOutputTaintMap(mergedOutputTaints);
          }
          if (removePolicy) {
            const mergedOverrides = {
              ...DEFAULT_COMPOSITE_TOOL_OVERRIDES,
              ...(config?.toolOverrides ?? {}),
              ...(updated.toolOverrides ?? {}),
            };
            defaultPolicyConfig = buildPolicyConfig(
              config?.taintPolicy as any,
              mergedOverrides,
              config?.maxIterations,
              logger,
            );
          }

          const removed: string[] = [];
          if (removePolicy) removed.push("call policy override");
          if (removeOutputTaint) removed.push("output taint override");
          logger.info(`[provenance] /trust-tool remove: "${tool}" — removed ${removed.join(", ")} (hot-reloaded)`);
          return {
            text:
              `✅ Removed from \`${tool}\`: ${removed.join(", ")}\n` +
              "In-memory config updated immediately.",
          };
        } catch (err) {
          return { text: `❌ Failed to write config: ${String(err)}` };
        }
      }

      return {
        text:
          "Usage:\n" +
          "  `/trust-tool add <tool[.sub]> [--policy allow|restrict] [--output-taint <level>]`\n" +
          "  `/trust-tool remove <tool[.sub]> --policy | --output-taint`\n" +
          "  `/trust-tool list`\n\n" +
          "Examples:\n" +
          "  `/trust-tool add exec --policy allow`\n" +
          "  `/trust-tool add message.read --output-taint shared`\n" +
          "  `/trust-tool add exec.curl --output-taint trusted`\n" +
          "  `/trust-tool remove exec.curl --output-taint`",
      };
    },
  });

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

  // --- before_agent_start ---
  // NOTE: This hook may not fire on all OpenClaw versions. Watermark clearing
  // is in context_assembled. Latency tracking now also uses context_assembled
  // as the baseline since before_agent_start is unreliable.

    // --- inbound_claim — cache identity from inbound message events ---
  //
  // Mainline does not populate senderId/senderIsOwner/sourceProvider/
  // groupId on the agent hookCtx. We capture those from the
  // inbound_claim event payload (which has them natively) and cache
  // by sessionKey for the agent-loop hooks to look up.
  api.on(
    "inbound_claim",
    profiled(
      "inbound_claim",
      createInboundClaimHandler({ identityStore, ownerNumbers, logger }),
    ),
  );

  // --- subagent_spawned — capture parent→child session relationship ---
  //
  // Used by the parent-taint inheritance logic to find a sub-agent's
  // parent without relying on agent-hookCtx spawnedBy.
  api.on(
    "subagent_spawned",
    profiled(
      "subagent_spawned",
      createSubagentSpawnedHandler({ identityStore, logger }),
    ),
  );

  // --- before_reset hook — /new and /reset clear session watermark ---
  // before_reset fires async (fire-and-forget in core), so we can't clear
  // the watermark here directly — context_assembled may already be running.
  // Instead, mark the session in resetPendingSessions; context_assembled
  // will check this set and skip watermark inheritance for that turn,
  // clearing the stale watermark before it can be inherited.
  api.on(
    "before_reset",
    profiled("before_reset", (_event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      if (sessionKey === "unknown") return;

      resetPendingSessions.add(sessionKey);
      logger.info(
        `[provenance:${shortKey(sessionKey)}] 🔄 TRUST_RESET (/new or /reset): marked for watermark clear on next context_assembled`,
      );
    }),
  );

  // --- before_prompt_build (replaces context_assembled + before_llm_call) ---
  //
  // Mainline removed context_assembled and before_llm_call; before_prompt_build
  // is the supported pre-call hook for prompt-policy mutation. We collapse
  // the previous two handlers' work into this single subscription:
  //
  //   - turn-start setup (was context_assembled): cache agentId + isOwnerDm,
  //     scan messages for browser tab URLs, watermark inheritance, parent
  //     taint inheritance.
  //   - prompt mutation (was before_llm_call): append taint introspection
  //     to systemPrompt via result.appendSystemContext.
  //
  // Tool filtering by taint moves entirely to before_tool_call (which
  // we already subscribe to). Identity fields (senderId, senderIsOwner,
  // sourceProvider, groupId, spawnedBy, senderName) are read from the
  // IdentityStore (populated by the inbound_claim handler) instead of
  // from the agent hookCtx, which mainline does not populate for these.
  api.on(
    "before_prompt_build",
    profiled("before_prompt_build", (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const identity = identityStore.get(sessionKey);
      if (ctx.agentId) sessionAgentMap.set(sessionKey, ctx.agentId);
      sessionOwnerDmMap.set(sessionKey, isOwnerDm(identity));
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
              // Top-level { targetId, url }. Mainline's enrichTabResponseBody
              // (extensions/browser/src/browser/routes/agent.shared.ts) now
              // guarantees these fields on every tab-targeting browser
              // response, so the previous { details: { targetId, url } }
              // fallback branch is no longer needed.
              if (typeof parsed?.targetId === "string" && typeof parsed?.url === "string") {
                recordTabUrls([{ targetId: parsed.targetId, url: parsed.url }]);
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
      const isSystemSession = isSystemSourceSession({
        identity,
        messageProvider: ctx.messageProvider,
        sessionKey,
      });

      // System-source sessions (heartbeat/cron/exec-event) cannot legitimately
      // hold persisted non-trusted watermarks: they are not user-driven, and
      // any "taint" on them is by definition stale (e.g. from a previous bug
      // where classifyInitialTrust returned non-trusted before the sessionKey
      // suffix fallback was wired). Drain any non-trusted watermark at turn
      // start so the inheritance block below is a no-op and the seal-handler
      // doesn't immediately re-escalate from the next interrupted heartbeat.
      if (isSystemSession) {
        const stale = watermarkStore.get(sessionKey);
        if (stale && stale.level !== "trusted") {
          watermarkStore.clear(sessionKey);
          watermarkStore.flush();
          logger.info(
            `[provenance:${shortKey(sessionKey)}] 🧹 SYSTEM_SESSION_WATERMARK_DRAIN: cleared stale watermark (was ${stale.level}: ${stale.reason ?? "no reason"}) on system-source session.`,
          );
        }
      }

      // If a previous turn was interrupted (sealed without completing),
      // persist its watermark escalation now so taint is never silently lost.
      // Skip for system-source sessions: heartbeat/cron turns getting
      // interrupted is normal (process restart, idle deadline) and should
      // not poison the watermark.
      if (sealedPrevious && !isSystemSession) {
        const sealedMaxTaint = sealedPrevious.summary().maxTaint;
        if (sealedMaxTaint && sealedMaxTaint !== "trusted") {
          const _agentId = sessionAgentMap.get(sessionKey) ?? ctx.agentId ?? "unknown";
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
      //   - /reset-trust   (registered plugin command, fires pre-agent-loop)
      //   - /new           (creates a new session key with no watermark entry)
      // Never clear based on messageCount — it's unreliable in thread/channel
      // contexts where each turn may report messageCount=1 despite being an
      // ongoing conversation.

      const initialTrust = classifyInitialTrust({
        identity,
        messageProvider: ctx.messageProvider,
        trustedSenderIds,
        missingIdentityTrust: config?.missingIdentityTrust,
        sessionKey,
      });

      // before_prompt_build's event payload does not carry messageCount or
      // systemPrompt directly; derive both from `messages`. The first system
      // message (if any) serves as the systemPrompt for graph recording
      // purposes (only its length is consumed downstream).
      const promptBuildMessages = event.messages ?? [];
      const messageCount = promptBuildMessages.length;
      const inferredSystemPrompt = (() => {
        for (const m of promptBuildMessages) {
          if (m?.role !== "system") continue;
          if (typeof m.content === "string") return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .filter((p: any) => p?.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text as string)
              .join("\n");
          }
          break;
        }
        return "";
      })();

      graph.recordContextAssembled(inferredSystemPrompt, messageCount, initialTrust);

      // If /new or /reset fired since the last turn, clear the stale watermark
      // before checking inheritance. before_reset marks the session async, so
      // we consume and clear the flag here, inside the synchronous hook dispatch.
      if (resetPendingSessions.has(sessionKey)) {
        resetPendingSessions.delete(sessionKey);
        const stale = watermarkStore.get(sessionKey);
        if (stale) {
          watermarkStore.clear(sessionKey);
          watermarkStore.flush();
          blockedToolsBySession.delete(sessionKey);
          approvalStore.clearAll(sessionKey);
          logger.info(
            `[provenance:${shortKey(sessionKey)}] 🔄 TRUST_RESET (/new or /reset): cleared stale watermark (was ${stale.level}) → trusted`,
          );
        }
      }

      // Inherit taint watermark from previous turns (same-session)
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

      // Inherit taint from parent session (cross-session propagation).
      // When a tainted parent spawns a subagent, the child must inherit
      // the parent's taint to prevent taint laundering.
      const spawnedBy = identity?.spawnedBy ?? null;
      if (spawnedBy) {
        // Check parent's persisted watermark (completed previous turns)
        const parentWm = watermarkStore.getLevel(spawnedBy);
        // Check parent's active graph (current in-flight turn — the parent's
        // message_sending hasn't fired yet, so its watermark hasn't
        // been flushed for the current turn)
        const parentGraph = store.getActive(spawnedBy);
        let parentTaint: TrustLevel = "trusted";
        if (parentWm) parentTaint = minTrust(parentTaint, parentWm.level);
        if (parentGraph) parentTaint = minTrust(parentTaint, parentGraph.maxTaint);

        if (parentTaint !== "trusted") {
          const parentSk = shortKey(spawnedBy);
          graph.addNode({
            id: "inherited-parent-taint",
            kind: "history",
            trust: parentTaint,
            metadata: {
              reason: `inherited from parent (${parentSk})`,
              parentSessionKey: spawnedBy,
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

      logger.info(`[provenance:${sk}] ── Turn Start ──`);
      logger.info(
        `[provenance:${sk}]   Messages: ${event.messageCount ?? 0} | System prompt: ${(event.systemPrompt ?? "").length} chars`,
      );
      logger.info(
        `[provenance:${sk}]   CLASSIFY_INITIAL_TRUST: ${initialTrust} | sender=${identity?.senderName ?? identity?.senderId ?? "unknown"} owner=${identity?.senderIsOwner ?? "unset"} group=${identity?.groupId ?? "none"} provider=${ctx.messageProvider ?? "none"}${identity?.sourceProvider ? ` sourceProvider=${identity.sourceProvider}` : ""} effectiveProvider=${identity?.sourceProvider ?? ctx.messageProvider ?? "none"}`,
      );
      if (watermark) {
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

      // ── Taint introspection footer (was injected via before_llm_call's
      //    systemPrompt return value; now via before_prompt_build's
      //    appendSystemContext, which is cacheable across the turn). ──
      //
      // Lets the LLM see its own security state — critical for correct
      // reasoning about which tools are available and why some may be
      // blocked. The footer is appended (not replaced) so it composes
      // cleanly with other plugins' system-prompt contributions.
      const currentTaintForFooter = graph.maxTaint;
      const taintEmoji =
        currentTaintForFooter === "trusted"
          ? "\uD83D\uDFE2"
          : currentTaintForFooter === "shared"
            ? "\uD83D\uDFE1"
            : currentTaintForFooter === "external"
              ? "\uD83D\uDFE0"
              : "\uD83D\uDD34";
      const currentWmForFooter = watermarkStore.getLevel(sessionKey);
      const wmInfo =
        currentWmForFooter && currentWmForFooter.level !== "trusted"
          ? ` | watermark: ${currentWmForFooter.level} (${currentWmForFooter.reason ?? "unknown"})`
          : "";
      const resetHint =
        currentTaintForFooter !== "trusted"
          ? " | Owner can use /reset-trust to clear."
          : "";
      const taintIntrospection = `\n[Security] ${taintEmoji} Taint: ${currentTaintForFooter}${wmInfo}${resetHint}`;

      return { appendSystemContext: taintIntrospection };
    }),
  );

  // --- llm_input — LLM-call observation (was inside before_llm_call) ---
  //
  // before_llm_call has been removed from mainline. The new architecture
  // splits its responsibilities:
  //   - systemPrompt mutation (taint footer)   → before_prompt_build above
  //                                                via appendSystemContext
  //   - LLM-call observation (recordLlmCall,   → this llm_input subscription
  //                            latency)
  //   - policy evaluation + tool gating        → before_tool_call below
  //
  // The legacy block-the-whole-turn return path (`{ block: true, ... }`) is
  // gone; tool-level blocking via before_tool_call achieves the same
  // security outcome (LLM call proceeds, but no tainted/non-approved
  // tools execute). Pending-confirmation logging is replicated in
  // before_tool_call.
  api.on(
    "llm_input",
    profiled("llm_input", (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const graph = store.getActive(sessionKey);
      if (!graph) return;

      // Iteration count is derived from graph state — the new event
      // payload does not carry an iteration field, but the graph already
      // tracks iteration cardinality via the recordLlmCall counter.
      const iteration = graph.iterationCount + 1;
      const llmNodeId = graph.recordLlmCall(iteration, 0);
      lastLlmNodeBySession.set(sessionKey, llmNodeId);

      const sk = shortKey(sessionKey);

      // Latency tracking: time from before_prompt_build → first LLM call
      if (iteration <= 1 && turnStartTimes.has(sessionKey)) {
        const turnT0 = turnStartTimes.get(sessionKey);
        if (turnT0 !== undefined) {
          const latencyMs = performance.now() - turnT0;
          logger.info(
            `[provenance:${sk}] ⏱ prompt_build→first_llm: ${latencyMs.toFixed(0)}ms`,
          );
          turnStartTimes.delete(sessionKey);
        }
      }

      logger.info(
        `[provenance:${sk}] ── LLM Call (iteration ${iteration}) ──`,
      );
      logger.info(
        `[provenance:${sk}]   Taint: ${graph.maxTaint} | model: ${event.model ?? "unknown"} | provider: ${event.provider ?? "unknown"}`,
      );
    }),
  );

  // --- llm_output (replaces after_llm_call) ---
  //
  // after_llm_call has been removed from mainline. The new llm_output
  // hook is observation-only and does NOT carry toolCalls in its event
  // payload — tool-call gating and per-tool taint logging now live
  // entirely in before_tool_call (which fires before each individual
  // tool call, replacing the batch-style filtering that lived here).
  //
  // What remains here: lightweight per-call observation logging so the
  // provenance log narrates the model output. Taint evaluation still
  // happens in after_tool_call (post-execution).
  api.on(
    "llm_output",
    profiled("llm_output", (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const graph = store.getActive(sessionKey);
      if (!graph) return;

      const sk = shortKey(sessionKey);
      const assistantTexts: string[] = Array.isArray(event.assistantTexts)
        ? event.assistantTexts
        : [];
      const totalChars = assistantTexts.reduce(
        (n: number, t: string) => n + (typeof t === "string" ? t.length : 0),
        0,
      );
      logger.info(
        `[provenance:${sk}] ── LLM Response (iteration ${graph.iterationCount}) ──`,
      );
      logger.info(
        `[provenance:${sk}]   Output text: ${totalChars} chars across ${assistantTexts.length} part(s) | model: ${event.model ?? "unknown"} | provider: ${event.provider ?? "unknown"}`,
      );
      logger.info(
        `[provenance:${sk}]   Established taint: ${graph.maxTaint} (taint evaluation deferred to after_tool_call)`,
      );
    }),
  );

  // --- loop_iteration_start / loop_iteration_end DROPPED ---
  //
  // The original handlers were observation-only diagnostics:
  //   - loop_iteration_start: logged "Iteration N start (M messages)"
  //   - loop_iteration_end: called graph.recordIterationEnd(iteration,
  //       toolCallsMade, willContinue) — pure bookkeeping, not used
  //       downstream by any policy decision.
  //
  // Mainline removed both hooks. graph.iterationCount is still kept
  // accurate via recordLlmCall in llm_input above. The lost log lines
  // are diagnostic-only, not security-relevant.

  // --- agent_end + message_sending (replaces before_response_emit) ---
  //
  // before_response_emit has been removed from mainline. Its work splits:
  //   - turn-completion bookkeeping (recordOutput, completeTurn,
  //     watermark persistence, summary logging) → agent_end
  //   - developer-mode footer mutation on outbound content → message_sending
  //
  // The skip-on-NO_REPLY/HEARTBEAT_OK guard moves to message_sending,
  // which fires per outbound message and naturally skips when content
  // is one of the silent markers.
  api.on(
    "agent_end",
    profiled("agent_end", (event: any, ctx: AgentContext) => {
      const sessionKey = ctx.sessionKey ?? "unknown";
      const graph = store.getActive(sessionKey);
      if (!graph) return;

      // Last assistant message text → drives recordOutput length.
      const messages: any[] = Array.isArray(event.messages) ? event.messages : [];
      let lastAssistantText = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== "assistant") continue;
        if (typeof m.content === "string") {
          lastAssistantText = m.content;
          break;
        }
        if (Array.isArray(m.content)) {
          lastAssistantText = m.content
            .filter((p: any) => p?.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text as string)
            .join("\n");
          break;
        }
      }

      // Skip turn-completion bookkeeping for silent markers — they are
      // not real agent replies. (Mirrors the legacy NO_REPLY/HEARTBEAT_OK
      // guard from before_response_emit.)
      const trimmed = lastAssistantText.trim();
      if (/^\s*NO_REPLY(?=$|\W)/m.test(trimmed)) return;
      if (trimmed === "HEARTBEAT_OK" || /\bHEARTBEAT_OK\s*$/.test(trimmed)) return;

      graph.recordOutput(lastAssistantText.length);

      const taintLevel = graph.maxTaint;
      const currentWatermark = watermarkStore.getLevel(sessionKey);
      const taintReason = buildTaintReason(graph, currentWatermark?.reason);

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
        .filter((n) => n.kind === "tool_call" && n.sourceUris?.length)
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
      logger.info(`[provenance:${sk}]   Final taint: ${summary.maxTaint}`);
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
                `Use /reset-trust to clear taint and retry, or review the staged write manually.`,
            };
          }
        }
      }

      // Resolve composite key for policy checks
      const params = event.params ?? {};
      const toolKey = resolveToolKey(toolName, params, compositeTools, execCommandRules);
      const toolKeyLower = toolKey.toLowerCase();

      // Message tool: owner DM exception (looks up identity by sessionKey;
      // mainline does not populate ownership/group on the agent hookCtx).
      const sessionKeyForOwnerDm = ctx.sessionKey ?? "unknown";
      if (toolNameLower === "message" && isOwnerDm(identityStore.get(sessionKeyForOwnerDm))) {
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
      // Taint is escalated in after_tool_call (post-execution). Within a
      // parallel batch, after_tool_call is fire-and-forget so some tools
      // may execute before taint escalates. Across batches, this re-eval
      // catches the escalation deterministically.
      if (graph) {
        const agentId = sessionAgentMap.get(sessionKey);
        const effectivePolicyConfig = getPolicyConfig(agentId);
        const mode = getToolMode(toolKeyLower, graph.maxTaint, effectivePolicyConfig);
        // Two-mode model: allow runs; restrict blocks UNLESS the owner has
        // approved this tool for the session via /approve-exec (trusted DM).
        // (The old separate "confirm" mode was folded into restrict+approval.)
        if (mode === "restrict" && !approvalStore.isApproved(sessionKey, toolKeyLower)) {
          logger.warn(
            `[provenance:${sk}] 🛑 BLOCKED at execution layer (real-time re-eval): ${toolName} | taint: ${graph.maxTaint}`,
          );
          return {
            block: true,
            blockReason:
              `Tool '${toolName}' is restricted because the session contains '${graph.maxTaint}' content.\n` +
              `Approve for this session: /approve-exec ${toolName}  (or /approve-exec all) from a trusted DM.\n` +
              `Or use /reset-trust to clear the taint entirely.`,
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
        return {
          block: true,
          blockReason:
            `Tool '${toolName}' is blocked by security policy. Context contains tainted content.\n` +
            `Blocked tools: ${blockedList}\n` +
            `Approve: /approve-exec ${toolName}  (or /approve-exec all)\n` +
            `Or use /reset-trust to clear all restrictions.`,
        };
      }
      return undefined;
    }),
  );


  // --- after_tool_call ---
  // PRIMARY taint evaluation site: evaluates trust AFTER tool execution,
  // using observed output rather than predictions. This is fire-and-forget
  // (tools execute in parallel), so taint escalation is best-effort within
  // a batch — but deterministic across batches since before_tool_call in the
  // next batch reads the updated graph.maxTaint.
  api.on(
    "after_tool_call",
    profiled("after_tool_call", (event: any, _ctx: any) => {
      const toolName = event.toolName;
      const params = event.params ?? {};
      const result = event.result;
      const sessionKey = _ctx.sessionKey ?? lastToolCallSessionKey;
      const graph = store.getActive(sessionKey);
      if (!graph) return;

      const toolKey = resolveToolKey(toolName, params, compositeTools, execCommandRules);
      const agentId = sessionAgentMap.get(sessionKey);
      const effectiveToolTaints = getResolvedToolTaints(agentId);
      const effectiveUriTrustConfig = getUriTrustConfig(agentId);
      const sk = shortKey(sessionKey);
      const llmNodeId = lastLlmNodeBySession.get(sessionKey);

      // --- Browser tab URL seeding (browser.tabs) ---
      if (toolKey === "browser.tabs" && result && typeof result === "object") {
        const content = Array.isArray((result as any).content) ? (result as any).content : [];
        for (const part of content) {
          if (part?.type === "text" && typeof part.text === "string") {
            const raw = part.text;
            if (!raw.includes('"tabs"')) continue;
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

      // --- Browser URL extraction from results ---
      //
      // Mainline's enrichTabResponseBody (extensions/browser/src/browser/
      // routes/agent.shared.ts, PR #30323 absorbed 2026-04-25) guarantees
      // top-level { targetId, url } on every tab-targeting browser response.
      // Previously this block had to probe three shapes:
      //   1. result.details.{ targetId, url }      (legacy structured)
      //   2. content[].text JSON top-level         (MCP standard, post-enrichment)
      //   3. content[].text JSON details.{...}     (legacy nested)
      // Shapes (1) and (3) are obsolete — enrichment mirrors the data to the
      // top level. We keep the content[].text scan because the response
      // body is serialised into MCP text parts before reaching this hook,
      // so the JSON we want to read lives in part.text, not in `result`
      // directly. Falls back gracefully if a non-enriched response slips
      // through (no record is made — same as the old failure path).
      //
      // browserUrl is also used by the URI trust evaluation below to
      // augment sourceUris with the observed URL.
      let browserUrl: string | undefined;
      const isBrowserContent =
        BROWSER_CONTENT_TOOLS.has(toolKey) ||
        (toolKey.startsWith("browser.") && toolKey !== "browser.tabs") ||
        (toolName.toLowerCase() === "browser" && toolKey === toolName);

      if (isBrowserContent && result && typeof result === "object") {
        const content = Array.isArray((result as any).content) ? (result as any).content : [];
        outer: for (const part of content) {
          if (part?.type !== "text" || typeof part.text !== "string") continue;
          const raw = part.text;
          if (!raw.includes('"url"')) continue;
          const candidates = [raw, raw.substring(raw.indexOf("{"), raw.lastIndexOf("}") + 1)];
          for (const candidate of candidates) {
            if (!candidate) continue;
            try {
              const parsed = JSON.parse(candidate);
              if (typeof parsed?.url !== "string") continue;
              browserUrl = parsed.url;
              const tid =
                typeof parsed?.targetId === "string" ? parsed.targetId : params.targetId;
              if (typeof tid === "string") {
                recordTabUrls([{ targetId: tid, url: parsed.url }]);
              }
              break outer;
            } catch {
              // Try next candidate.
            }
          }
        }
      }

      // --- Universal taint evaluation ---
      // Compute effective trust from tool output taint + URI classification.
      // This is the ONLY place where graph.recordToolCall() is called for
      // tool execution taint (after_llm_call no longer escalates).

      // Extract source URIs from params (pre-execution knowledge)
      const sourceUris = extractToolSourceUris(
        toolKey,
        toolName,
        params,
        uriExtractors,
        execCommandRules,
      );

      // For browser content tools, the actual URL from the result takes priority
      // over any URIs extracted from params (which may be stale/missing).
      if (isBrowserContent && typeof browserUrl === "string") {
        // Replace or augment source URIs with the observed URL
        if (!sourceUris.includes(browserUrl)) {
          sourceUris.push(browserUrl);
        }
      }

      // Compute tool trust using composite key
      const toolTrust = getToolTrust(toolKey, effectiveToolTaints);

      // Compute URI trust (overrides tool trust if matched)
      let effectiveTrust = toolTrust;
      if (sourceUris.length > 0) {
        const uriTrust = classifyUris(sourceUris, effectiveUriTrustConfig);
        if (uriTrust !== undefined) {
          effectiveTrust = uriTrust;
        }
      }

      // Owner DM exception: message tools from owner are trusted
      const ownerDm = sessionOwnerDmMap.get(sessionKey) ?? false;
      if (ownerDm && toolKey.startsWith("message.") && effectiveTrust !== "trusted") {
        effectiveTrust = "trusted";
      }

      // Record in provenance graph — this is where taint escalation happens
      const taintBefore = graph.maxTaint;
      graph.recordToolCall(
        toolKey,
        0, // iteration not reliably available in after_tool_call
        llmNodeId,
        effectiveToolTaints,
        { sourceUris, effectiveTrust },
      );

      // Log taint evaluation result
      if (graph.maxTaint !== taintBefore) {
        logger.warn(
          `[provenance:${sk}]   TOOL_TAINT_ESCALATION: ${taintBefore} → ${graph.maxTaint} caused by: ${toolKey}(${effectiveTrust}${sourceUris.length > 0 ? ` uri:${truncate(sourceUris[0], 40)}` : ""})`,
        );
      } else if (verbose) {
        logger.info(
          `[provenance:${sk}]   TOOL_TAINT_EVAL: ${toolKey}(${effectiveTrust}) → taint unchanged at ${graph.maxTaint}`,
        );
      }
    }),
  );

  return { store, approvalStore };
}
