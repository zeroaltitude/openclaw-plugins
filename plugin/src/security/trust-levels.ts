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

/** Default trust classifications for tools */
export const DEFAULT_TOOL_TRUST: Record<string, TrustLevel> = {
  // Local operations
  "Read": "local",
  "Edit": "local",
  "Write": "local",
  "exec": "local",
  "process": "local",
  
  // Web / untrusted
  "web_fetch": "untrusted",
  "web_search": "untrusted",
  "browser": "untrusted",
  
  // Shared memory
  "vestige_search": "shared",
  "vestige_smart_ingest": "shared",
  "vestige_ingest": "shared",
  "vestige_promote": "shared",
  "vestige_demote": "shared",
  "memory_search": "shared",
  "memory_get": "shared",
  
  // External sources
  "message": "external",   // reads from channels contain external content
  "gog": "external",       // email/calendar content
  
  // Image analysis  
  "image": "external",     // analyzing external images
  
  // Actions (not content sources, but policy targets)
  "tts": "local",
  "cron": "local",
  "gateway": "system",
  "session_status": "system",
  "sessions_spawn": "local",
  "sessions_send": "local",
  "sessions_list": "local",
  "sessions_history": "local",
  "agents_list": "local",
  "nodes": "local",
  "canvas": "local",
};

// --- Taint policy modes ---

export type TaintPolicyMode = "allow" | "deny" | "restrict";

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

/** Get trust level for a tool, defaulting to "local" for unknown tools */
export function getToolTrust(toolName: string, overrides?: Record<string, TrustLevel>): TrustLevel {
  if (overrides?.[toolName]) return overrides[toolName];
  return DEFAULT_TOOL_TRUST[toolName] ?? "local";
}
