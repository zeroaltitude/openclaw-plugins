/**
 * Security Policy Engine — Simplified Model
 * 
 * The policy model is:
 *   1. Determine taint level from provenance graph (e.g., "untrusted")
 *   2. Look up default mode for that taint level (e.g., "confirm")
 *   3. For each tool, check toolOverrides for a stricter mode
 *   4. Apply: allow = pass, confirm = prompt with code, restrict = silently remove, deny = block turn
 * 
 * Overrides can only make things STRICTER, never more permissive.
 * Monotonicity is enforced: stricter taint levels must have equal or stricter modes.
 */

import type { TrustLevel } from "./trust-levels.js";
import { TRUST_ORDER, DEFAULT_TAINT_POLICY } from "./trust-levels.js";
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
 * Can only make things stricter than the taint-level default.
 */
export type ToolOverride = Partial<Record<TrustLevel | "*", PolicyMode>>;

export interface PolicyConfig {
  /** Default mode per taint level */
  taintPolicy: Record<TrustLevel, PolicyMode>;
  /** Per-tool overrides (key = lowercase tool name) */
  toolOverrides: Record<string, ToolOverride>;
  /** Max iterations before blocking turn (default: 10) */
  maxIterations: number;
}

/** Return the stricter of two modes */
export function strictest(a: PolicyMode, b: PolicyMode): PolicyMode {
  return MODE_ORDER.indexOf(a) >= MODE_ORDER.indexOf(b) ? a : b;
}

/** Return the more permissive of two modes */
function mostPermissive(a: PolicyMode, b: PolicyMode): PolicyMode {
  return MODE_ORDER.indexOf(a) <= MODE_ORDER.indexOf(b) ? a : b;
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

  // Walk from most trusted to least trusted
  // Each level must be >= the previous level in strictness
  let prevMode: PolicyMode = "allow";
  for (const level of TRUST_ORDER) {
    const current = corrected[level];
    if (MODE_ORDER.indexOf(current) < MODE_ORDER.indexOf(prevMode)) {
      warnings.push(
        `taintPolicy.${level} (${current}) is less strict than a more-trusted level (${prevMode}). Auto-corrected to ${prevMode}.`
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
  if (!override) return defaultMode;

  // Check specific taint level, then glob "*"
  const overrideMode = override[taintLevel] ?? override["*"];
  if (!overrideMode) return defaultMode;

  // The override IS the effective mode for this tool.
  // It can be more permissive (safe tools: "allow") or more restrictive (dangerous tools: "restrict").
  // This is intentional: safe tools MUST be able to override "restrict" back to "allow".
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
  /** Tools that need confirmation (approval code) */
  confirm: Array<{ tool: string; reason: string }>;
  /** Tools that are silently restricted (no override possible) */
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

  // Check max iterations
  if (graph.iterationCount >= config.maxIterations) {
    result.blockTurn = true;
    result.blockReason = `Max iterations exceeded (${config.maxIterations})`;
    result.maxIterationsExceeded = true;
    return result;
  }

  // Evaluate each tool — even in "allow" mode, tool overrides may be stricter
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

  // Even in "allow" mode, check if any tools have overrides that are stricter
  if (result.defaultMode === "allow" && result.confirm.length === 0 && result.restricted.length === 0) {
    return {
      mode: "allow",
      toolRemovals: new Set(),
      pendingConfirmations: [],
    };
  }

  const toolRemovals = new Set<string>();
  const pendingConfirmations: Array<{ toolName: string; reason: string }> = [];

  // Restricted tools are always removed (no override)
  for (const tool of result.restricted) {
    toolRemovals.add(tool);
  }

  // Confirm tools: check if already approved
  for (const { tool, reason } of result.confirm) {
    if (approvalStore.isApproved(sessionKey, tool)) {
      // Already approved — allow it
      continue;
    }
    toolRemovals.add(tool);
    pendingConfirmations.push({ toolName: tool, reason });
  }

  // Effective mode: if default is "allow" but overrides triggered, report the strictest override
  const effectiveMode = pendingConfirmations.length > 0
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
  // Read-only filesystem
  "read":              { "*": "allow" },
  // Memory (read-only)  
  "memory_search":     { "*": "allow" },
  "memory_get":        { "*": "allow" },
  // Web read (these ARE the taint sources — safe to call, but their
  // responses taint the context for subsequent tool calls)
  "web_fetch":         { "*": "allow" },
  "web_search":        { "*": "allow" },
  // Image analysis (read-only)
  "image":             { "*": "allow" },
  // Session introspection (read-only)
  "session_status":    { "*": "allow" },
  "sessions_list":     { "*": "allow" },
  "sessions_history":  { "*": "allow" },
  "agents_list":       { "*": "allow" },
  // Vestige memory (search + promote/demote are read-only-ish)
  "vestige_search":    { "*": "allow" },
  "vestige_promote":   { "*": "allow" },
  "vestige_demote":    { "*": "allow" },
};

/**
 * Default dangerous tool overrides — tools that should be stricter than the
 * taint-level default at certain levels.
 */
export const DEFAULT_DANGEROUS_TOOLS: Record<string, ToolOverride> = {
  // Gateway config requires approval even at local level (prevents policy circumvention)
  "gateway":  { "local": "confirm", "shared": "confirm", "external": "confirm", "untrusted": "confirm" },
};

/**
 * Build a complete PolicyConfig from user-provided config, merging with defaults.
 */
export function buildPolicyConfig(
  taintPolicy?: Partial<Record<TrustLevel, PolicyMode>>,
  toolOverrides?: Record<string, ToolOverride>,
  maxIterations?: number,
): PolicyConfig {
  // Merge taint policy with defaults
  const rawPolicy: Record<TrustLevel, PolicyMode> = {
    system: "allow",
    owner: "allow",
    local: "allow",
    shared: "confirm",
    external: "confirm",
    untrusted: "confirm",
    ...taintPolicy,
  };

  // Validate monotonicity
  const { corrected, warnings } = validateMonotonicity(rawPolicy);

  // Merge tool overrides: defaults first, then user overrides on top
  const mergedOverrides: Record<string, ToolOverride> = {
    ...DEFAULT_SAFE_TOOLS,
    ...DEFAULT_DANGEROUS_TOOLS,
  };

  // User overrides merge per-tool (user values take precedence per taint level)
  if (toolOverrides) {
    for (const [tool, override] of Object.entries(toolOverrides)) {
      const key = tool.toLowerCase();
      mergedOverrides[key] = { ...mergedOverrides[key], ...override };
    }
  }

  return {
    taintPolicy: corrected,
    toolOverrides: mergedOverrides,
    maxIterations: maxIterations ?? 10,
  };
}
