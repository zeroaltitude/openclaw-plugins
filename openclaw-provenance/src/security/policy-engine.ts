/**
 * Security Policy Engine — 4-Level Model
 *
 * The policy model is:
 *   1. Determine taint level from provenance graph (e.g., "untrusted")
 *   2. Look up default mode for that taint level (e.g., "confirm")
 *   3. For each tool, check toolOverrides for a different mode
 *   4. Apply: allow = pass, confirm = block until owner approves, restrict = silently remove
 *
 * Monotonicity is enforced: stricter taint levels must have equal or stricter modes.
 */

import type { TrustLevel } from "./trust-levels.js";
import {
  TRUST_ORDER,
  mapLegacyTaintPolicy,
  mapLegacyToolOverride,
  hasLegacyKeys,
} from "./trust-levels.js";
import type { TaintPolicyConfig } from "./trust-levels.js";
import type { ApprovalStore } from "./approval-store.js";
import type { TurnProvenanceGraph } from "./provenance-graph.js";

// Re-export for backward compat
export type { TaintPolicyConfig };

/** Policy modes in order of strictness */
export type PolicyMode = "allow" | "confirm" | "restrict";
const MODE_ORDER: PolicyMode[] = ["allow", "confirm", "restrict"];

/**
 * Per-tool override: maps taint levels (or "*") to a policy mode.
 */
export type ToolOverride = Partial<Record<TrustLevel | "*", PolicyMode>>;

export interface PolicyConfig {
  /** Default mode per taint level */
  taintPolicy: Record<TrustLevel, PolicyMode>;
  /** Per-tool overrides (key = lowercase tool name) */
  toolOverrides: Record<string, ToolOverride>;
  /** Max iterations before warning (default: 30) */
  maxIterations: number;
}

/** Return the stricter of two modes */
export function strictest(a: PolicyMode, b: PolicyMode): PolicyMode {
  return MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b;
}

/**
 * Validate and fix monotonicity: stricter taint levels must have equal or stricter modes.
 * Returns the corrected config and any warnings.
 */
export function validateMonotonicity(
  taintPolicy: Record<TrustLevel, PolicyMode>,
): { corrected: Record<TrustLevel, PolicyMode>; warnings: string[] } {
  const corrected = { ...taintPolicy };
  const warnings: string[] = [];

  let prevMode: PolicyMode = "allow";
  for (const level of TRUST_ORDER) {
    const current = corrected[level];
    if (MODE_ORDER.indexOf(current) < MODE_ORDER.indexOf(prevMode)) {
      warnings.push(
        `taintPolicy.${level} (${current}) is less strict than a more-trusted level (${prevMode}). Auto-corrected to ${prevMode}.`,
      );
      corrected[level] = prevMode;
    }
    prevMode = corrected[level];
  }

  return { corrected, warnings };
}

/**
 * Get the effective policy mode for a specific tool at a specific taint level.
 */
export function getToolMode(
  toolName: string,
  taintLevel: TrustLevel,
  config: PolicyConfig,
): PolicyMode {
  const defaultMode = config.taintPolicy[taintLevel] ?? "restrict";
  const override = config.toolOverrides[toolName.toLowerCase()];

  if (!override) {
    // Unknown tool: when taint policy allows at this level, trust the policy.
    // When restrictive, use the untrusted mode to prevent tool rename attacks.
    if (defaultMode === "allow") {
      return defaultMode;
    }
    const untrustedMode = config.taintPolicy["untrusted"] ?? "restrict";
    return strictest(defaultMode, untrustedMode);
  }

  // Check specific taint level, then glob "*"
  const overrideMode = override[taintLevel] ?? override["*"];
  if (!overrideMode) return defaultMode;

  // The override IS the effective mode for this tool.
  // It can be more permissive (safe tools: "allow") or more restrictive.
  return overrideMode;
}

/**
 * Evaluate all tools and return categorized results.
 */
export interface PolicyResult {
  /** The taint level that triggered evaluation */
  taintLevel: TrustLevel;
  /** The default mode for this taint level */
  defaultMode: PolicyMode;
  /** Tools that are allowed (no restriction) */
  allowed: string[];
  /** Tools that need owner approval */
  confirm: Array<{ tool: string; reason: string }>;
  /** Tools that are silently restricted */
  restricted: string[];
  /** Whether the entire turn should be blocked */
  blockTurn: boolean;
  /** Block reason if applicable */
  blockReason?: string;
  /** Whether max iterations was exceeded */
  maxIterationsExceeded: boolean;
}

export function evaluatePolicy(
  graph: TurnProvenanceGraph,
  availableTools: string[],
  config: PolicyConfig,
): PolicyResult {
  const taintLevel = graph.maxTaint;
  const defaultMode = config.taintPolicy[taintLevel] ?? "restrict";

  const result: PolicyResult = {
    taintLevel,
    defaultMode,
    allowed: [],
    confirm: [],
    restricted: [],
    blockTurn: false,
    maxIterationsExceeded: false,
  };

  if (graph.iterationCount >= config.maxIterations) {
    result.maxIterationsExceeded = true;
  }

  for (const tool of availableTools) {
    const mode = getToolMode(tool, taintLevel, config);
    switch (mode) {
      case "allow":
        result.allowed.push(tool);
        break;
      case "confirm":
        result.confirm.push({
          tool,
          reason: `${tool} requires approval at taint level "${taintLevel}"`,
        });
        break;
      case "restrict":
        result.restricted.push(tool);
        break;
    }
  }

  return result;
}

/**
 * Evaluate policy with approval support.
 * Returns the final set of tools to remove after considering approvals.
 */
export function evaluateWithApprovals(
  graph: TurnProvenanceGraph,
  availableTools: string[],
  config: PolicyConfig,
  approvalStore: ApprovalStore,
  sessionKey: string,
): {
  mode: PolicyMode;
  toolRemovals: Set<string>;
  pendingConfirmations: Array<{ toolName: string; reason: string }>;
  block?: boolean;
  blockReason?: string;
} {
  const result = evaluatePolicy(graph, availableTools, config);

  if (result.blockTurn) {
    return {
      mode: result.defaultMode,
      toolRemovals: new Set(),
      pendingConfirmations: [],
      block: true,
      blockReason: result.blockReason,
    };
  }

  // Fast path: everything allowed
  if (
    result.defaultMode === "allow" &&
    result.confirm.length === 0 &&
    result.restricted.length === 0
  ) {
    return {
      mode: "allow",
      toolRemovals: new Set(),
      pendingConfirmations: [],
    };
  }

  const toolRemovals = new Set<string>();
  const pendingConfirmations: Array<{ toolName: string; reason: string }> = [];

  // Restricted tools are always removed
  for (const tool of result.restricted) {
    toolRemovals.add(tool);
  }

  // Confirm tools: check if already approved by owner
  for (const { tool, reason } of result.confirm) {
    if (approvalStore.isApproved(sessionKey, tool)) {
      continue;
    }
    toolRemovals.add(tool);
    pendingConfirmations.push({ toolName: tool, reason });
  }

  const effectiveMode =
    pendingConfirmations.length > 0
      ? strictest(result.defaultMode, "confirm")
      : result.restricted.length > 0
        ? strictest(result.defaultMode, "restrict")
        : result.defaultMode;

  return {
    mode: effectiveMode,
    toolRemovals,
    pendingConfirmations,
  };
}

/**
 * Default safe tools that should always be allowed regardless of taint.
 * These are read-only tools with no side effects.
 */
export const DEFAULT_SAFE_TOOLS: Record<string, ToolOverride> = {
  read: { "*": "allow" },
  memory_search: { "*": "allow" },
  memory_get: { "*": "allow" },
  web_fetch: { "*": "allow" },
  web_search: { "*": "allow" },
  image: { "*": "allow" },
  session_status: { "*": "allow" },
  sessions_list: { "*": "allow" },
  sessions_history: { "*": "allow" },
  agents_list: { "*": "allow" },
  gateway: { "*": "allow" },
  vestige_search: { "*": "allow" },
  vestige_promote: { "*": "allow" },
  vestige_demote: { "*": "allow" },
};

/**
 * Default taint-level-default tools — known tools that follow the taint-level
 * default policy (no per-tool override). Explicitly listing them ensures they
 * are recognized as "known" and don't fall through to the unknown-tool policy.
 */
export const DEFAULT_TAINT_DEFAULT_TOOLS: Record<string, ToolOverride> = {
  exec: {},
  edit: {},
  write: {},
  process: {},
  browser: {},
  message: {},
  canvas: {},
  nodes: {},
  tts: {},
  cron: {},
  sessions_send: {},
  sessions_spawn: {},
  vestige_ingest: {},
  vestige_smart_ingest: {},
  gog: {},
};

/**
 * Default dangerous tool overrides — tools that should be stricter than the
 * taint-level default at certain levels.
 */
export const DEFAULT_DANGEROUS_TOOLS: Record<string, ToolOverride> = {};

/**
 * Build a complete PolicyConfig from user-provided config, merging with defaults.
 */
export function buildPolicyConfig(
  taintPolicy?: Partial<Record<string, PolicyMode>>,
  toolOverrides?: Record<string, ToolOverride>,
  maxIterations?: number,
  logger?: {
    warn(...args: any[]): void;
  },
): PolicyConfig {
  // Handle legacy 6-level configs
  let resolvedPolicy: Partial<Record<string, PolicyMode>> = (taintPolicy ?? {}) as Partial<Record<string, PolicyMode>>;
  if (taintPolicy && hasLegacyKeys(taintPolicy as Record<string, unknown>)) {
    const { mapped, warnings } = mapLegacyTaintPolicy(
      taintPolicy as Record<string, string>,
    );
    for (const w of warnings) {
      logger?.warn(`[provenance] ${w}`);
    }
    resolvedPolicy = mapped as Partial<Record<string, PolicyMode>>;
  }

  const rawPolicy: Record<TrustLevel, PolicyMode> = {
    trusted: "allow",
    shared: "confirm",
    external: "confirm",
    untrusted: "confirm",
    ...(resolvedPolicy as Partial<Record<TrustLevel, PolicyMode>>),
  };

  const { corrected, warnings } = validateMonotonicity(rawPolicy);
  for (const w of warnings) {
    logger?.warn(`[provenance] ${w}`);
  }

  // Merge tool overrides: defaults first, then user overrides on top
  const mergedOverrides: Record<string, ToolOverride> = {
    ...DEFAULT_TAINT_DEFAULT_TOOLS,
    ...DEFAULT_SAFE_TOOLS,
    ...DEFAULT_DANGEROUS_TOOLS,
  };

  if (toolOverrides) {
    for (const [tool, override] of Object.entries(toolOverrides)) {
      const key = tool.toLowerCase();
      // Map legacy 6-level keys in tool overrides
      const mappedOverride = hasLegacyKeys(override as Record<string, unknown>)
        ? mapLegacyToolOverride(override as Record<string, string>)
        : override;
      mergedOverrides[key] = {
        ...mergedOverrides[key],
        ...(mappedOverride as ToolOverride),
      };
    }
  }

  return {
    taintPolicy: corrected,
    toolOverrides: mergedOverrides,
    maxIterations: maxIterations ?? 30,
  };
}
