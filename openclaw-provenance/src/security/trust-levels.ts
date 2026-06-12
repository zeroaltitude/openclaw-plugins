/**
 * Trust level taxonomy for content provenance.
 *
 * Four levels, ordered from most trusted to least trusted:
 *   trusted  — system prompts, owner messages, local tool output
 *   shared   — cross-agent data (Vestige, shared memory)
 *   external — known external sources (email, Slack, calendar)
 *   untrusted — web content, unknown webhooks
 *
 * The previous six-level model (system/owner/local/shared/external/untrusted)
 * collapsed the top three into "trusted" because they all behaved identically.
 */

export type TrustLevel = "trusted" | "shared" | "external" | "untrusted";

/** Ordered from most trusted to least trusted */
export const TRUST_ORDER: TrustLevel[] = ["trusted", "shared", "external", "untrusted"];

/** Returns the lower (less trusted) of two trust levels */
export function minTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  const idxA = TRUST_ORDER.indexOf(a);
  const idxB = TRUST_ORDER.indexOf(b);
  return idxA >= idxB ? a : b; // higher index = lower trust
}

// ── Legacy 6-level mapping ──────────────────────────────────────────────────

/** Legacy trust level names from the old 6-level model */
export type LegacyTrustLevel =
  | "system"
  | "owner"
  | "local"
  | "shared"
  | "external"
  | "untrusted";

/** Map a legacy 6-level trust to the new 4-level model */
export function mapLegacyTrust(level: string): TrustLevel {
  switch (level) {
    case "trusted":
    case "system":
    case "owner":
    case "local":
      return "trusted";
    case "shared":
      return "shared";
    case "external":
      return "external";
    case "untrusted":
      return "untrusted";
    default:
      return "untrusted"; // unknown → untrusted (secure default)
  }
}

/** Check if a taint policy config uses legacy 6-level keys */
export function hasLegacyKeys(
  policy: Record<string, unknown>,
): boolean {
  return ["system", "owner", "local"].some((k) => k in policy);
}

/**
 * Map a legacy 6-level taint policy to 4-level.
 * For trusted: uses the most permissive of system/owner/local (they should all be "allow").
 * Returns the mapped policy and any warnings.
 */
export function mapLegacyTaintPolicy(
  legacy: Record<string, string>,
): { mapped: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const mapped: Record<string, string> = {};

  if (hasLegacyKeys(legacy)) {
    warnings.push(
      "taintPolicy uses deprecated 6-level keys (system/owner/local). " +
        "These are mapped to 'trusted' automatically. Please update to 4-level format.",
    );
    // Pick the most permissive of system/owner/local for "trusted"
    const MODE_ORDER = ["allow", "confirm", "restrict"];
    const candidates = ["system", "owner", "local"]
      .map((k) => legacy[k])
      .filter(Boolean);
    if (candidates.length > 0) {
      mapped.trusted = candidates.reduce((a, b) =>
        MODE_ORDER.indexOf(a) <= MODE_ORDER.indexOf(b) ? a : b,
      );
    }
  }

  // Pass through 4-level keys
  if (legacy.trusted) mapped.trusted = legacy.trusted;
  if (legacy.shared) mapped.shared = legacy.shared;
  if (legacy.external) mapped.external = legacy.external;
  if (legacy.untrusted) mapped.untrusted = legacy.untrusted;

  return { mapped, warnings };
}

/**
 * Map legacy 6-level tool override keys to 4-level.
 * system/owner/local keys → "trusted". shared/external/untrusted pass through.
 */
export function mapLegacyToolOverride(
  override: Record<string, string>,
): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(override)) {
    if (key === "system" || key === "owner" || key === "local") {
      // Use the most permissive if multiple legacy keys map to trusted
      const MODE_ORDER = ["allow", "confirm", "restrict"];
      if (
        !mapped.trusted ||
        MODE_ORDER.indexOf(value) < MODE_ORDER.indexOf(mapped.trusted)
      ) {
        mapped.trusted = value;
      }
    } else {
      mapped[key] = value;
    }
  }
  return mapped;
}

// ── Tool output taint classifications ───────────────────────────────────────

/**
 * Default tool output taint classifications.
 *
 * Each entry maps a tool name to the trust level of its *output* —
 * i.e., the taint that its response introduces into the context.
 * This is independent of whether the tool is safe to *call*.
 *
 * These defaults can be overridden via the `toolOutputTaints` config block.
 * Unknown tools default to "untrusted".
 */
export const DEFAULT_TOOL_OUTPUT_TAINTS: Record<string, TrustLevel> = {
  // ── Trusted operations ────────────────────────────────────────────
  Read: "trusted",
  Edit: "trusted",
  Write: "trusted",
  // dir_list / dir_fetch / file_fetch / file_write: read or write to paired
  // nodes the owner has provisioned. All four are policy-gated by
  // gateway.nodes.allowCommands plus per-node allowReadPaths/allowWritePaths;
  // unconfigured calls are denied. Treating their output as untrusted by
  // default poisons agent heartbeat watermarks (see
  // provenance:agent:<id>:<channel>:heartbeat) without protecting anything
  // the policy layer hasn't already authorized.
  dir_list: "trusted",
  dir_fetch: "trusted",
  file_fetch: "trusted",
  file_write: "trusted",
  // apply_patch and edit are SDK-native file-edit primitives used by both
  // codex and claude harnesses (apply_patch is codex's edit tool;
  // edit is openclaw's bundled write tool). Their output is patch-result
  // metadata, not external data — same shape as file_write above. Treating
  // them as untrusted-by-default was inconsistent and meant every
  // file-editing turn silently tainted its session (visible as "tool
  // output: apply_patch" in /provenance across every agent doing coding).
  apply_patch: "trusted",
  edit: "trusted",
  exec: "trusted",
  process: "trusted",
  tts: "trusted",
  cron: "trusted",
  sessions_spawn: "trusted",
  sessions_send: "trusted",
  sessions_list: "trusted",
  sessions_history: "trusted",
  sessions_yield: "trusted",
  agents_list: "trusted",
  nodes: "trusted",
  canvas: "trusted",
  gateway: "trusted",
  heartbeat_respond: "trusted",
  session_status: "trusted",
  subagents: "trusted",
  update_plan: "trusted",

  // ── Local wiki vault (trusted: on-machine markdown vault, owner-controlled) ──
  wiki_status: "trusted",
  wiki_search: "trusted",
  wiki_get: "trusted",
  wiki_lint: "trusted",
  wiki_apply: "trusted",

  // ── Local memory (trusted: writes are guarded, so reads are safe) ──
  memory_search: "trusted",
  memory_get: "trusted",

  // ── Shared (cross-agent memory) ───────────────────────────────────
  vestige_search: "trusted", // local cognitive memory; default trusted (override if shared)
  vestige_smart_ingest: "trusted", // write-only, output is confirmation
  vestige_ingest: "trusted", // write-only, output is confirmation
  vestige_promote: "trusted", // write-only, output is confirmation
  vestige_demote: "trusted", // write-only, output is confirmation
  vestige_dream: "trusted", // local memory consolidation; output is insights
  vestige_consolidate: "trusted", // FSRS-6 maintenance cycle; output is stats
  vestige_importance_score: "trusted", // scoring helper; no external data
  vestige_explore_connections: "trusted", // graph traversal of local memory
  vestige_predict: "trusted", // prediction from local memory state
  vestige_session_context: "trusted", // combined session init from local memory
  vestige_backup: "trusted", // local SQLite VACUUM INTO; output is path/status

  // ── External sources ──────────────────────────────────────────────
  message: "external", // channel messages contain external content

  // ── message subtools: internal platform metadata (shared by default; deployments can elevate) ──
  "message.member-info": "shared",      // guild member data; internal platform metadata
  "message.channel-members": "shared",  // channel membership; internal platform metadata
  "message.channel-info": "shared",     // channel metadata; internal platform
  "message.channel-list": "shared",     // channel listing; internal platform
  "message.role-info": "shared",        // role metadata; internal platform

  gog: "external", // email/calendar content
  image: "external", // analyzing external images

  // ── Untrusted / web ───────────────────────────────────────────────
  web_fetch: "untrusted",
  web_search: "untrusted",
  browser: "untrusted",
};

// Legacy alias for backward compatibility
export const DEFAULT_TOOL_TRUST = DEFAULT_TOOL_OUTPUT_TAINTS;

// ── MCP-namespaced tool name handling ──────────────────────────────────────
//
// When Claude or Codex calls an OpenClaw tool via an MCP server, the tool
// name arrives prefixed with the MCP server identifier — e.g.,
// `mcp__openclaw__sessions_spawn` (claude extension's openclaw bridge) or
// `mcp__codex_apps__github_list_installed_account_repositories` (codex's
// app marketplace tools).
//
// Two recognition rules are applied during getToolTrust():
//   1. Strip the MCP prefix and try the bare name in the trust map first —
//      this routes `mcp__openclaw__sessions_spawn` to the existing
//      `sessions_spawn: "trusted"` entry without duplicating entries per
//      namespace.
//   2. If the bare name has no entry, fall back to the per-prefix default
//      below — for known trusted MCP namespaces this means "trusted"
//      rather than the global "untrusted" fallback.
//
// The two prefixes default to "trusted" because they're owned by OpenClaw
// integration code (the claude extension's dynamic-tools bridge and codex's
// own app server). Adding a third-party MCP server's tools would require
// explicit overrides via the `toolOutputTaints` config block.
const MCP_PREFIX_DEFAULTS: ReadonlyArray<[string, TrustLevel]> = [
  ["mcp__openclaw__", "trusted"],
  ["mcp__codex_apps__", "trusted"],
];

// ── Taint policy ────────────────────────────────────────────────────────────

export type TaintPolicyMode = "allow" | "confirm" | "restrict";

export interface TaintPolicyConfig {
  /** Policy for trusted content — system, owner, local (default: allow) */
  trusted?: TaintPolicyMode;
  /** Policy for shared/cross-agent data (default: confirm) */
  shared?: TaintPolicyMode;
  /** Policy for external sources (default: confirm) */
  external?: TaintPolicyMode;
  /** Policy for untrusted content (default: confirm) */
  untrusted?: TaintPolicyMode;
}

export const DEFAULT_TAINT_POLICY: Required<TaintPolicyConfig> = {
  trusted: "allow",
  shared: "confirm",
  external: "confirm",
  untrusted: "confirm",
};

/**
 * Build a resolved tool output taint map by merging defaults with config overrides.
 * Call once at startup; pass the result to getToolTrust() for each lookup.
 */
export function buildToolOutputTaintMap(
  overrides?: Record<string, TrustLevel | string>,
): Record<string, TrustLevel> {
  const base = { ...DEFAULT_TOOL_OUTPUT_TAINTS };
  if (!overrides || Object.keys(overrides).length === 0) {
    return base;
  }
  // Map any legacy trust level names in overrides
  for (const [tool, level] of Object.entries(overrides)) {
    base[tool] = mapLegacyTrust(level);
  }
  return base;
}

/**
 * Get trust level for a tool's output. Uses a pre-merged map if provided, otherwise defaults.
 * Unknown tools (not in defaults or overrides) default to "untrusted" — this prevents
 * tool rename attacks where a dangerous tool is re-registered under an unlisted name.
 */
export function getToolTrust(
  toolName: string,
  resolvedMap?: Record<string, TrustLevel>,
): TrustLevel {
  // Exact match first (fast path)
  if (resolvedMap?.[toolName]) return resolvedMap[toolName];
  if (DEFAULT_TOOL_OUTPUT_TAINTS[toolName])
    return DEFAULT_TOOL_OUTPUT_TAINTS[toolName];

  // Case-insensitive fallback: tool names from LLM responses may differ in
  // casing from the trust map (e.g. "edit" vs "Edit", "read" vs "Read").
  const lower = toolName.toLowerCase();
  if (resolvedMap) {
    for (const [key, value] of Object.entries(resolvedMap)) {
      if (key.toLowerCase() === lower) return value;
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_TOOL_OUTPUT_TAINTS)) {
    if (key.toLowerCase() === lower) return value;
  }

  // Composite key fallback: plugin tools can resolve to keys such as
  // tweetclaw./api/v1/x/tweets/search while sharing a bare tool taint.
  if (lower.includes(".")) {
    const bareName = lower.slice(0, lower.indexOf("."));
    // Exact and case-insensitive composite-key lookup already missed above.
    if (resolvedMap) {
      for (const [key, value] of Object.entries(resolvedMap)) {
        if (key.toLowerCase() === bareName) return value;
      }
    }
    for (const [key, value] of Object.entries(DEFAULT_TOOL_OUTPUT_TAINTS)) {
      if (key.toLowerCase() === bareName) return value;
    }
  }

  // MCP-namespaced lookup: strip the prefix and try the bare name, then
  // fall back to the per-prefix default for known trusted namespaces.
  for (const [prefix, prefixDefault] of MCP_PREFIX_DEFAULTS) {
    if (!toolName.startsWith(prefix)) continue;
    const bareName = toolName.slice(prefix.length);
    if (resolvedMap?.[bareName]) return resolvedMap[bareName];
    if (DEFAULT_TOOL_OUTPUT_TAINTS[bareName]) return DEFAULT_TOOL_OUTPUT_TAINTS[bareName];
    const bareLower = bareName.toLowerCase();
    // MCP prefixes are stripped only after non-namespaced composite fallbacks miss.
    if (resolvedMap) {
      for (const [key, value] of Object.entries(resolvedMap)) {
        if (key.toLowerCase() === bareLower) return value;
      }
    }
    for (const [key, value] of Object.entries(DEFAULT_TOOL_OUTPUT_TAINTS)) {
      if (key.toLowerCase() === bareLower) return value;
    }
    return prefixDefault;
  }

  return "untrusted";
}
