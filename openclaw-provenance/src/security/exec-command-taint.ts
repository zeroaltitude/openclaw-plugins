/**
 * Exec Command Taint Classification
 *
 * Pattern-based output taint classification and URI extraction for `exec`
 * tool calls. Inspects the `command` parameter to identify commands that
 * fetch external content, and classifies their output accordingly.
 *
 * Design principles:
 *   - No match → trusted (fail-working, same as today)
 *   - Patterns match the first command token or known subcommand patterns
 *   - URI extraction pulls URLs from command arguments for trust classification
 *   - User config can add/override patterns
 *
 * This plugs into the existing composite-tools and URI extractor systems:
 *   - resolveExecToolKey() returns composite keys like "exec.curl", "exec.wget"
 *   - extractExecUris() returns URIs found in the command string
 *   - DEFAULT_EXEC_OUTPUT_TAINTS provides default taint for each composite key
 */

import type { TrustLevel } from "./trust-levels.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecCommandRule {
  /** Pattern to match against the command string (regex) */
  pattern: RegExp;
  /** Composite key suffix (e.g., "curl" → resolves to "exec.curl") */
  key: string;
  /** Default output taint for this command class */
  outputTaint: TrustLevel;
  /**
   * How to extract URIs from the command.
   * - "url-args": extract URL-like arguments (https?://, http://)
   * - "none": no URI extraction (taint based on key alone)
   */
  uriExtraction: "url-args" | "none";
}

// ── Default Rules ───────────────────────────────────────────────────────────

/**
 * Built-in exec command rules.
 *
 * Order matters: first match wins. More specific patterns should come first.
 * These cover common CLI tools that fetch or display external content.
 */
export const DEFAULT_EXEC_COMMAND_RULES: ExecCommandRule[] = [
  // ── Browser automation CLIs ──
  {
    pattern: /\bagent-browser\s+snapshot\b/,
    key: "agent-browser-snapshot",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bagent-browser\s+screenshot\b/,
    key: "agent-browser-screenshot",
    outputTaint: "trusted",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bagent-browser\s+open\b/,
    key: "agent-browser-open",
    outputTaint: "trusted",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bagent-browser\s+(click|fill|type|close|select|hover|press|sessions?)\b/,
    key: "agent-browser-action",
    outputTaint: "trusted",
    uriExtraction: "none",
  },
  {
    pattern: /\bplaywright\b/,
    key: "playwright",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bpuppeteer\b/,
    key: "puppeteer",
    outputTaint: "external",
    uriExtraction: "url-args",
  },

  // ── HTTP clients ──
  {
    pattern: /\bcurl\s/,
    key: "curl",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bwget\s/,
    key: "wget",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bhttpie\b|\bhttp\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/,
    key: "httpie",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bfetch\s/,
    key: "fetch",
    outputTaint: "external",
    uriExtraction: "url-args",
  },

  // ── Web scrapers / content renderers ──
  {
    pattern: /\blynx\s/,
    key: "lynx",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bw3m\s/,
    key: "w3m",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\blinks\s/,
    key: "links",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bshot-scraper\b/,
    key: "shot-scraper",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bmonolith\s/,
    key: "monolith",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\breadability-cli\b|\breadable\s/,
    key: "readability",
    outputTaint: "external",
    uriExtraction: "url-args",
  },

  // ── Python HTTP (common agent patterns) ──
  {
    pattern: /\bpython3?\s.*\b(requests|urllib|httpx|aiohttp)\b/,
    key: "python-http",
    outputTaint: "external",
    uriExtraction: "url-args",
  },
  {
    pattern: /\bpython3?\s.*\b(scrapy|beautifulsoup|bs4|selenium|playwright)\b/,
    key: "python-scraper",
    outputTaint: "external",
    uriExtraction: "url-args",
  },

  // ── Node.js HTTP ──
  {
    pattern: /\bnode\b.*\b(fetch|axios|got|node-fetch|undici)\b/,
    key: "node-http",
    outputTaint: "external",
    uriExtraction: "url-args",
  },

  // ── DNS / network recon (output reveals external infrastructure) ──
  {
    pattern: /\bdig\s/,
    key: "dig",
    outputTaint: "external",
    uriExtraction: "none",
  },
  {
    pattern: /\bnslookup\s/,
    key: "nslookup",
    outputTaint: "external",
    uriExtraction: "none",
  },
  {
    pattern: /\bwhois\s/,
    key: "whois",
    outputTaint: "external",
    uriExtraction: "none",
  },

  // ── Package managers (download external code) ──
  {
    pattern: /\bnpm\s+install\b|\bnpx\s/,
    key: "npm-install",
    outputTaint: "external",
    uriExtraction: "none",
  },
  {
    pattern: /\bpip\s+install\b/,
    key: "pip-install",
    outputTaint: "external",
    uriExtraction: "none",
  },

  // ── SSH / remote execution (output is from an external host) ──
  {
    pattern: /\bssh\s/,
    key: "ssh",
    outputTaint: "shared",
    uriExtraction: "none",
  },
  {
    pattern: /\bscp\s/,
    key: "scp",
    outputTaint: "shared",
    uriExtraction: "none",
  },
];

// ── Composite key and URI extraction for exec output taints ─────────────

/**
 * Build the default output taint map from exec command rules.
 * Returns entries like { "exec.curl": "external", "exec.wget": "external" }
 */
export function buildExecOutputTaints(
  rules: ExecCommandRule[] = DEFAULT_EXEC_COMMAND_RULES,
): Record<string, TrustLevel> {
  const taints: Record<string, TrustLevel> = {};
  for (const rule of rules) {
    taints[`exec.${rule.key}`] = rule.outputTaint;
  }
  return taints;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Match an exec command string against rules and return the matching rule.
 * Returns undefined if no rule matches (fail-working → trusted).
 */
export function matchExecCommand(
  command: string,
  rules: ExecCommandRule[] = DEFAULT_EXEC_COMMAND_RULES,
): ExecCommandRule | undefined {
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Resolve an exec tool call to a composite key.
 *
 * Examines the `command` parameter and matches against known patterns.
 * Returns "exec.<key>" on match, or "exec" if no match (fail-working).
 */
export function resolveExecToolKey(
  params: Record<string, unknown>,
  rules: ExecCommandRule[] = DEFAULT_EXEC_COMMAND_RULES,
): string {
  const command = params.command;
  if (typeof command !== "string") return "exec";

  const rule = matchExecCommand(command, rules);
  return rule ? `exec.${rule.key}` : "exec";
}

// ── URI Extraction ──────────────────────────────────────────────────────────

/** Regex to extract URLs from command strings */
const URL_PATTERN = /https?:\/\/[^\s"'`<>|;)}\]]+/gi;

/**
 * Extract URIs from an exec command string.
 *
 * Only extracts when the matched rule specifies uriExtraction: "url-args".
 * Returns empty array for unmatched commands or rules with "none" extraction.
 */
export function extractExecUris(
  params: Record<string, unknown>,
  rules: ExecCommandRule[] = DEFAULT_EXEC_COMMAND_RULES,
): string[] {
  const command = params.command;
  if (typeof command !== "string") return [];

  const rule = matchExecCommand(command, rules);
  if (!rule || rule.uriExtraction !== "url-args") return [];

  const matches = command.match(URL_PATTERN);
  return matches ?? [];
}

// ── User config merging ─────────────────────────────────────────────────────

export interface ExecCommandRuleConfig {
  /** Regex pattern string (will be compiled with word boundary awareness) */
  pattern: string;
  /** Composite key suffix */
  key: string;
  /** Output taint classification */
  outputTaint: TrustLevel;
  /** URI extraction strategy */
  uriExtraction?: "url-args" | "none";
}

/**
 * Build the merged exec command rules: built-in defaults + user overrides.
 *
 * User rules are prepended (higher priority / first match wins).
 */
export function buildExecCommandRules(
  configOverrides?: ExecCommandRuleConfig[],
): ExecCommandRule[] {
  const userRules: ExecCommandRule[] = (configOverrides ?? []).map((cfg) => ({
    pattern: new RegExp(cfg.pattern),
    key: cfg.key,
    outputTaint: cfg.outputTaint,
    uriExtraction: cfg.uriExtraction ?? "url-args",
  }));

  return [...userRules, ...DEFAULT_EXEC_COMMAND_RULES];
}
