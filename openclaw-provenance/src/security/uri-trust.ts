/**
 * URI Trust Classification
 *
 * Classifies URIs into trust levels using glob-like pattern matching.
 * Built-in defaults for common schemes; user config overrides via `uriTrust`.
 *
 * Pattern matching:
 *   - `*` matches a single segment (no dots in domain, no slashes in path)
 *   - `**` matches any number of segments
 *   - Most-specific pattern wins (CSS-style specificity)
 *
 * Resolution:
 *   - URI trust overrides tool trust (default/override model)
 *   - No URI match → tool trust stands as the effective trust
 */

import { type TrustLevel, TRUST_ORDER } from "./trust-levels.js";

// ── Config ──────────────────────────────────────────────────────────────────

export interface UriTrustPattern {
  pattern: string;
  trust: TrustLevel;
  /** Computed specificity — higher = more specific */
  specificity: number;
  /** Compiled regex for matching */
  regex: RegExp;
}

export interface UriTrustConfig {
  patterns: UriTrustPattern[];
}

// ── Default URI trust table ─────────────────────────────────────────────────

/**
 * Built-in URI trust defaults.
 *
 * These provide sensible trust for common URI schemes. The workspaceDir
 * placeholder is resolved at build time via `buildUriTrustConfig()`.
 */
export const DEFAULT_URI_TRUST_PATTERNS: Record<string, TrustLevel> = {
  // Local filesystem
  "file:///tmp/**": "shared",

  // Cross-agent memory
  "vestige://**": "shared",
  "memory://**": "trusted",

  // Google Workspace
  "google://**": "external",

  // Channel messages (default — can be overridden per-channel)
  "slack://**": "external",
  "discord://**": "external",
  "telegram://**": "external",
  "whatsapp://**": "external",
  "signal://**": "external",
  "irc://**": "external",
  "googlechat://**": "external",
  "imessage://**": "external",
  "channel://**": "external",
  "channel-search://**": "external",

  // Search engines
  "brave-search://**": "external",

  // Local commands
  "exec://**": "trusted",

  // OpenClaw first-party domains
  "https://openclaw.ai/**": "trusted",
  "https://docs.openclaw.ai/**": "trusted",
  "https://clawhub.com/**": "trusted",

  // Web (catch-all — should be last)
  "https://**": "untrusted",
  "http://**": "untrusted",
};

// ── Specificity calculation ─────────────────────────────────────────────────

/**
 * Calculate pattern specificity for priority ordering.
 *
 * CSS-style: count non-wildcard segments. More explicit segments = higher priority.
 * Ties broken by total pattern length (longer = more specific).
 *
 * Examples:
 *   "https://github.com/owner/repo/**" → 4 (scheme + domain + 2 path segments)
 *   "https://github.com/**"            → 2 (scheme + domain)
 *   "https://**"                       → 1 (scheme only)
 *   "file:///home/user/**"             → 3 (scheme + 2 path segments)
 */
function calculateSpecificity(pattern: string): number {
  // Split on :// to get scheme and rest
  const schemeEnd = pattern.indexOf("://");
  if (schemeEnd === -1) return 0;

  const rest = pattern.slice(schemeEnd + 3);

  // Count non-wildcard segments
  const segments = rest.split("/").filter((s) => s.length > 0);
  let explicitCount = 0;
  for (const seg of segments) {
    if (seg !== "*" && seg !== "**" && !seg.includes("*")) {
      explicitCount++;
    }
  }

  // Base: 1 for having a non-wildcard scheme, plus explicit segments
  const schemeStr = pattern.slice(0, schemeEnd);
  const schemeScore = schemeStr.includes("*") ? 0 : 1;

  // Tiebreaker: pattern length (in thousandths, to not override segment count)
  const tiebreaker = pattern.length / 10000;

  return schemeScore + explicitCount + tiebreaker;
}

// ── Pattern compilation ─────────────────────────────────────────────────────

/**
 * Compile a glob-like URI pattern to a regex.
 *
 * - `*` in domain position matches a single domain label (no dots)
 * - `*` in path position matches a single path segment (no slashes)
 * - `**` matches any number of segments (including zero)
 */
function compilePattern(pattern: string): RegExp {
  // Split pattern at :// to handle domain and path contexts separately.
  // In domain context (before first / after ://), * matches a single label (no dots).
  // In path context, * matches a single segment (no slashes).
  const schemeEnd = pattern.indexOf("://");
  let domainPart: string;
  let pathPart: string;

  if (schemeEnd !== -1) {
    const afterScheme = pattern.slice(schemeEnd + 3);
    const firstSlash = afterScheme.indexOf("/");
    if (firstSlash !== -1) {
      domainPart = pattern.slice(0, schemeEnd + 3 + firstSlash);
      pathPart = afterScheme.slice(firstSlash);
    } else {
      domainPart = pattern;
      pathPart = "";
    }
  } else {
    domainPart = "";
    pathPart = pattern;
  }

  function compileSegment(segment: string, singleStarPattern: string): string {
    // Escape regex special chars except * and /
    let regex = segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    // Replace ** with placeholder first
    regex = regex.replace(/\*\*/g, "___GLOBSTAR___");
    // Replace remaining * with context-appropriate match
    regex = regex.replace(/\*/g, singleStarPattern);
    // Replace globstar with match-anything
    regex = regex.replace(/___GLOBSTAR___/g, ".*");
    return regex;
  }

  const domainRegex = compileSegment(domainPart, "[^./]*");
  const pathRegex = compileSegment(pathPart, "[^/]*");

  // When path is exactly "/**", ** should match zero or more segments —
  // including no path at all. Make the leading "/" optional so that
  // "https://openclaw.ai/**" matches both "https://openclaw.ai" and
  // "https://openclaw.ai/anything".
  if (pathPart === "/**") {
    return new RegExp(`^${domainRegex}(/.*)?$`, "i");
  }

  return new RegExp(`^${domainRegex}${pathRegex}$`, "i");
}

// ── Config builder ──────────────────────────────────────────────────────────

/**
 * Build the URI trust config from defaults + user overrides.
 *
 * @param configOverrides  User-provided `uriTrust` config block
 * @param workspaceDir     Agent workspace directory (for file:// trust)
 */
export function buildUriTrustConfig(
  configOverrides?: Record<string, TrustLevel>,
  workspaceDir?: string,
): UriTrustConfig {
  const allPatterns: Record<string, TrustLevel> = {
    ...DEFAULT_URI_TRUST_PATTERNS,
  };

  // Add workspace-specific patterns
  if (workspaceDir) {
    const normalized = workspaceDir.replace(/\/$/, "");
    allPatterns[`file://${normalized}/**`] = "trusted";
  }

  // Default: local filesystem is shared
  allPatterns["file:///**"] = "shared";

  // User overrides win
  if (configOverrides) {
    for (const [pattern, trust] of Object.entries(configOverrides)) {
      allPatterns[pattern] = trust as TrustLevel;
    }
  }

  // Compile and sort by specificity (most specific first)
  const patterns: UriTrustPattern[] = Object.entries(allPatterns)
    .map(([pattern, trust]) => ({
      pattern,
      trust,
      specificity: calculateSpecificity(pattern),
      regex: compilePattern(pattern),
    }))
    .sort((a, b) => b.specificity - a.specificity);

  return { patterns };
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a URI into a trust level.
 *
 * Returns the trust level of the most specific matching pattern,
 * or `undefined` if no pattern matches (caller falls back to tool trust).
 */
export function classifyUri(
  uri: string,
  config: UriTrustConfig,
): TrustLevel | undefined {
  for (const entry of config.patterns) {
    if (entry.regex.test(uri)) {
      return entry.trust;
    }
  }
  return undefined;
}

/**
 * Classify multiple URIs and return the least trusted result.
 * Returns undefined if no URIs or no matches.
 */
export function classifyUris(
  uris: string[],
  config: UriTrustConfig,
): TrustLevel | undefined {
  if (uris.length === 0) return undefined;

  let worst: TrustLevel | undefined;
  for (const uri of uris) {
    const trust = classifyUri(uri, config);
    if (trust === undefined) continue;
    if (worst === undefined) {
      worst = trust;
    } else {
      const worstIdx = TRUST_ORDER.indexOf(worst);
      const trustIdx = TRUST_ORDER.indexOf(trust);
      if (trustIdx > worstIdx) worst = trust;
    }
  }
  return worst;
}
