/**
 * Trust level taxonomy for content provenance.
 * Trust propagates through the agent loop — derived artifacts inherit
 * the lowest trust of their inputs.
 */

export type TrustLevel = 
  | "system"      // System prompt, SOUL.md, AGENTS.md — highest trust
  | "owner"       // Direct messages from the verified owner  
  | "local"       // Tool results from local operations (file reads, exec)
  | "shared"      // Shared memory (Vestige), other agents' contributions
  | "external"    // Email, Slack, calendar — known sources, not controlled
  | "untrusted";  // Web content, unknown webhooks — lowest trust

/** Ordered from most trusted to least trusted */
export const TRUST_ORDER: TrustLevel[] = [
  "system", "owner", "local", "shared", "external", "untrusted"
];

/** Returns the lower (less trusted) of two trust levels */
export function minTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  const idxA = TRUST_ORDER.indexOf(a);
  const idxB = TRUST_ORDER.indexOf(b);
  return idxA >= idxB ? a : b;  // higher index = lower trust
}

/**
 * Default tool output taint classifications.
 * 
 * Each entry maps a tool name to the trust level of its *output* —
 * i.e., the taint that its response introduces into the context.
 * This is independent of whether the tool is safe to *call*.
 * 
 * These defaults can be overridden via the `toolOutputTaints` config block.
 * Unknown tools default to "local".
 */
export const DEFAULT_TOOL_OUTPUT_TAINTS: Record<string, TrustLevel> = {
  // ── Local operations ──────────────────────────────────────────────
  "Read": "local",
  "Edit": "local",
  "Write": "local",
  "exec": "local",
  "process": "local",
  "tts": "local",
  "cron": "local",
  "sessions_spawn": "local",
  "sessions_send": "local",
  "sessions_list": "local",
  "sessions_history": "local",
  "agents_list": "local",
  "nodes": "local",
  "canvas": "local",

  // ── System ────────────────────────────────────────────────────────
  "gateway": "system",
  "session_status": "system",

  // ── Shared memory ─────────────────────────────────────────────────
  "vestige_search": "shared",
  "vestige_smart_ingest": "shared",
  "vestige_ingest": "shared",
  "vestige_promote": "shared",
  "vestige_demote": "shared",
  "memory_search": "shared",
  "memory_get": "shared",

  // ── External sources ──────────────────────────────────────────────
  "message": "external",     // channel messages contain external content
  "gog": "external",         // email/calendar content
  "image": "external",       // analyzing external images

  // ── Untrusted / web ───────────────────────────────────────────────
  "web_fetch": "untrusted",
  "web_search": "untrusted",
  "browser": "untrusted",
};

// Legacy alias for backward compatibility
export const DEFAULT_TOOL_TRUST = DEFAULT_TOOL_OUTPUT_TAINTS;

// --- Taint policy modes ---

export type TaintPolicyMode = "allow" | "deny" | "restrict" | "confirm";

export interface TaintPolicyConfig {
  /** Policy for system-trust content (default: allow) */
  system?: TaintPolicyMode;
  /** Policy for owner-trust content (default: allow) */
  owner?: TaintPolicyMode;
  /** Policy for local-trust content (default: allow) */
  local?: TaintPolicyMode;
  /** Policy for shared-trust content (default: restrict) */
  shared?: TaintPolicyMode;
  /** Policy for external-trust content (default: restrict) */
  external?: TaintPolicyMode;
  /** Policy for untrusted content (default: restrict) */
  untrusted?: TaintPolicyMode;
}

export const DEFAULT_TAINT_POLICY: Required<TaintPolicyConfig> = {
  system: "allow",
  owner: "allow",
  local: "allow",
  shared: "restrict",
  external: "restrict",
  untrusted: "restrict",
};

/**
 * Build a resolved tool output taint map by merging defaults with config overrides.
 * Call once at startup; pass the result to getToolTrust() for each lookup.
 */
export function buildToolOutputTaintMap(overrides?: Record<string, TrustLevel>): Record<string, TrustLevel> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return { ...DEFAULT_TOOL_OUTPUT_TAINTS };
  }
  return { ...DEFAULT_TOOL_OUTPUT_TAINTS, ...overrides };
}

/**
 * Get trust level for a tool's output. Uses a pre-merged map if provided, otherwise defaults.
 * Unknown tools (not in defaults or overrides) default to "untrusted" — this prevents
 * tool rename attacks where a dangerous tool is re-registered under an unlisted name.
 */
export function getToolTrust(toolName: string, resolvedMap?: Record<string, TrustLevel>): TrustLevel {
  // Exact match first (fast path)
  if (resolvedMap?.[toolName]) return resolvedMap[toolName];
  if (DEFAULT_TOOL_OUTPUT_TAINTS[toolName]) return DEFAULT_TOOL_OUTPUT_TAINTS[toolName];

  // Case-insensitive fallback: tool names from LLM responses may differ in
  // casing from the trust map (e.g. "edit" vs "Edit", "read" vs "Read").
  // Without this, unknown casing falls through to "untrusted", causing
  // spurious taint escalation and approval code prompts.
  const lower = toolName.toLowerCase();
  if (resolvedMap) {
    for (const [key, value] of Object.entries(resolvedMap)) {
      if (key.toLowerCase() === lower) return value;
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_TOOL_OUTPUT_TAINTS)) {
    if (key.toLowerCase() === lower) return value;
  }

  return "untrusted";
}
