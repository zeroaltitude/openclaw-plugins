/**
 * Security Policy Engine — 4-Level Trust, 2-Mode Policy
 *
 * The policy model is:
 *   1. Determine taint level from provenance graph (e.g., "untrusted")
 *   2. Look up default mode for that taint level (e.g., "restrict")
 *   3. For each tool, check toolOverrides for a different mode
 *   4. Apply: allow = pass; restrict = block UNLESS owner has approved the tool
 *      for the session via /approve-exec (trusted DM)
 *
 * Two modes only: allow and restrict. The legacy "confirm" mode was removed
 * (2026-05-27) — it duplicated what restrict+approval now does. Any "confirm"
 * in user config or persisted data is normalized to "restrict".
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

/**
 * Policy modes in order of strictness.
 *
 * Two modes only:
 *   allow    — execute unconditionally at this taint level
 *   restrict — blocked by default; the owner can override per-session via
 *              /approve-exec <tool> (or /approve-exec all) from a trusted DM.
 *
 * The legacy "confirm" mode was removed (2026-05-27). It was a separate
 * approvable gate that duplicated what restrict+approval now does, and the
 * three-mode model was confusing. Any "confirm" appearing in user config or
 * legacy data is normalized to "restrict" via normalizePolicyMode().
 */
export type PolicyMode = "allow" | "restrict";
const MODE_ORDER: PolicyMode[] = ["allow", "restrict"];

/** Legacy mode string that may still appear in user config / persisted data. */
type LegacyPolicyMode = PolicyMode | "confirm";

/**
 * Normalize a possibly-legacy mode string to a canonical PolicyMode.
 * "confirm" → "restrict" (both are approval-overridable now).
 */
export function normalizePolicyMode(mode: string | undefined): PolicyMode | undefined {
  if (mode === undefined) return undefined;
  if (mode === "allow") return "allow";
  if (mode === "restrict" || mode === "confirm") return "restrict";
  return undefined; // unknown string → caller decides fallback
}

/**
 * Per-tool override: maps taint levels (or "*") to a policy mode.
 * Accepts legacy "confirm" on input; normalized to "restrict" during merge.
 */
export type ToolOverride = Partial<Record<TrustLevel | "*", LegacyPolicyMode>>;

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
  const toolKey = toolName.toLowerCase();
  const bareToolKey = toolKey.includes(".")
    ? toolKey.slice(0, toolKey.indexOf("."))
    : toolKey;
  // Composite keys inherit the bare tool policy only after an exact match misses.
  const override =
    config.toolOverrides[toolKey] ?? config.toolOverrides[bareToolKey];

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
  const rawOverrideMode = override[taintLevel] ?? override["*"];
  if (!rawOverrideMode) return defaultMode;

  // The override IS the effective mode for this tool.
  // It can be more permissive ("allow") or more restrictive ("restrict").
  // Normalize any legacy "confirm" → "restrict" defensively.
  return normalizePolicyMode(rawOverrideMode) ?? defaultMode;
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
  /** Tools that are restricted (blocked unless owner-approved via /approve-exec) */
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
    restricted: [],
    blockTurn: false,
    maxIterationsExceeded: false,
  };

  if (graph.iterationCount >= config.maxIterations) {
    result.maxIterationsExceeded = true;
  }

  for (const tool of availableTools) {
    const mode = getToolMode(tool, taintLevel, config);
    if (mode === "allow") {
      result.allowed.push(tool);
    } else {
      result.restricted.push(tool);
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
  if (result.defaultMode === "allow" && result.restricted.length === 0) {
    return {
      mode: "allow",
      toolRemovals: new Set(),
      pendingConfirmations: [],
    };
  }

  const toolRemovals = new Set<string>();
  const pendingConfirmations: Array<{ toolName: string; reason: string }> = [];

  // Restricted tools: removed unless the owner has approved them this session.
  // (Approval overrides restrict — this is the unified gate that replaced the
  // old separate "confirm" mode.)
  for (const tool of result.restricted) {
    if (approvalStore.isApproved(sessionKey, tool)) {
      continue;
    }
    toolRemovals.add(tool);
    pendingConfirmations.push({
      toolName: tool,
      reason: `${tool} is restricted at taint level "${result.taintLevel}" — approve with /approve-exec`,
    });
  }

  const effectiveMode =
    toolRemovals.size > 0
      ? "restrict"
      : result.defaultMode;

  return {
    mode: effectiveMode,
    toolRemovals,
    pendingConfirmations,
  };
}

/**
 * Default tool execution policy.
 *
 * Maps each known tool name to its allowed execution modes per taint level.
 * The value is a ToolOverride: { taintLevel: policyMode } or { "*": policyMode }.
 *
 * Policy modes:
 *   allow   — execute unconditionally at this taint level
 *   confirm — blocked until owner runs /approve-exec <tool>; cannot bypass restrict
 *   restrict — hard block; /approve-exec has no effect, only /reset-trust clears it
 *
 * Tools not listed here fall through to the taint-policy default
 * (allow at trusted, confirm at shared/external/untrusted) with an extra
 * strictness penalty for unknown tools as a defence against tool-rename attacks.
 */
export const DEFAULT_TOOL_EXECUTION_POLICY: Record<string, ToolOverride> = {

  // ── Always-allow: read-only, no side effects ─────────────────────────────
  read:             { "*": "allow" },
  session_status:   { "*": "allow" },
  sessions_list:    { "*": "allow" },
  agents_list:      { "*": "allow" },
  heartbeat_respond: { "*": "allow" },
  update_plan:      { "*": "allow" },

  // ── Memory reads: allow at trusted+shared, restrict at external/untrusted ─
  // Restricting at external/untrusted prevents injected prompts from extracting
  // sensitive memories via crafted queries.
  memory_search: { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },
  memory_get:    { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },

  // ── Web / external reads: allow up to external, restrict at untrusted ─────
  // Prevents second-stage payload fetches and data exfiltration via injected prompts.
  web_fetch:        { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  web_search:       { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  image:            { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  sessions_history: { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },

  // ── Vestige reads/maintenance: restrict at untrusted ─────────────────────
  // dream/consolidate have no external input but restrict at untrusted for consistency.
  vestige_search:              { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_promote:             { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_demote:              { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_dream:               { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_consolidate:         { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_importance_score:    { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_explore_connections: { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_predict:             { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  vestige_session_context:     { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },

  // ── Shell / file mutation: restrict at external + untrusted ──────────────
  // Running shell commands or writing files while external/untrusted content is
  // in context is a classic prompt-injection vector. Restrict is owner-overridable
  // via /approve-exec on a trusted DM.
  exec:    { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },
  bash:    { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },
  edit:    { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },
  write:   { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },
  process: { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },

  // ── Browser: equivalent danger to shell — can exfiltrate, execute JS ──────
  browser: { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },

  // ── Channel messaging: exfil/social-engineering risk ─────────────────────
  message: { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },

  // ── Scheduling: cron jobs could persist malicious behaviour ──────────────
  cron: { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },

  // ── Cross-agent: lateral movement / agent-recruitment vector ─────────────
  sessions_send:  { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },
  sessions_spawn: { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },

  // ── Memory writes: memory-poisoning vector ────────────────────────────────
  vestige_ingest:       { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },
  vestige_smart_ingest: { trusted: "allow", shared: "allow", external: "restrict", untrusted: "restrict" },

  // ── Email/calendar: exfil and social-engineering risk ────────────────────
  gog: { trusted: "allow", shared: "restrict", external: "restrict", untrusted: "restrict" },

  // ── Taint-policy default (no per-level override needed) ──────────────────
  // Listed explicitly so the engine recognises them as known tools rather than
  // falling through to the unknown-tool strictness penalty.
  canvas: {},
  nodes:  {},
  tts:    {},

  // ── Gateway: normal infra work — allow except under untrusted taint ──────
  // Gateway management is routine; only gate it when genuinely untrusted content
  // is in context. Restrict is owner-overridable via /approve-exec.
  gateway: { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
};

// Legacy aliases — kept for backward compatibility with external consumers
// that imported the old split structure names.
/** @deprecated Use DEFAULT_TOOL_EXECUTION_POLICY */
export const DEFAULT_SAFE_TOOLS = DEFAULT_TOOL_EXECUTION_POLICY;
/** @deprecated Use DEFAULT_TOOL_EXECUTION_POLICY */
export const DEFAULT_TAINT_DEFAULT_TOOLS = DEFAULT_TOOL_EXECUTION_POLICY;
/** @deprecated Use DEFAULT_TOOL_EXECUTION_POLICY */
export const DEFAULT_DANGEROUS_TOOLS = DEFAULT_TOOL_EXECUTION_POLICY;

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

  // Normalize any legacy "confirm" in the resolved taint policy → "restrict".
  const normalizedResolved: Partial<Record<TrustLevel, PolicyMode>> = {};
  for (const [level, mode] of Object.entries(resolvedPolicy)) {
    const norm = normalizePolicyMode(mode as string);
    if (norm) normalizedResolved[level as TrustLevel] = norm;
  }

  const rawPolicy: Record<TrustLevel, PolicyMode> = {
    trusted: "allow",
    shared: "restrict",
    external: "restrict",
    untrusted: "restrict",
    ...normalizedResolved,
  };

  const { corrected, warnings } = validateMonotonicity(rawPolicy);
  for (const w of warnings) {
    logger?.warn(`[provenance] ${w}`);
  }

  // Merge tool overrides: defaults first, then user overrides on top.
  // Normalize legacy "confirm" → "restrict" in every override value.
  const mergedOverrides: Record<string, ToolOverride> = {
    ...DEFAULT_TOOL_EXECUTION_POLICY,
  };

  if (toolOverrides) {
    for (const [tool, override] of Object.entries(toolOverrides)) {
      const key = tool.toLowerCase();
      // Map legacy 6-level keys in tool overrides
      const mappedOverride = hasLegacyKeys(override as Record<string, unknown>)
        ? mapLegacyToolOverride(override as Record<string, string>)
        : override;
      // Normalize confirm → restrict in each per-level value
      const normalizedOverride: ToolOverride = {};
      for (const [level, mode] of Object.entries(mappedOverride as Record<string, string>)) {
        const norm = normalizePolicyMode(mode);
        if (norm) (normalizedOverride as Record<string, PolicyMode>)[level] = norm;
      }
      mergedOverrides[key] = {
        ...mergedOverrides[key],
        ...normalizedOverride,
      };
    }
  }

  // Also normalize the built-in defaults (they were authored before the
  // confirm→restrict migration may have fully propagated through edits).
  for (const key of Object.keys(mergedOverrides)) {
    const ov = mergedOverrides[key];
    const normalized: ToolOverride = {};
    for (const [level, mode] of Object.entries(ov as Record<string, string>)) {
      const norm = normalizePolicyMode(mode);
      if (norm) (normalized as Record<string, PolicyMode>)[level] = norm;
    }
    mergedOverrides[key] = normalized;
  }

  return {
    taintPolicy: corrected,
    toolOverrides: mergedOverrides,
    maxIterations: maxIterations ?? 30,
  };
}
