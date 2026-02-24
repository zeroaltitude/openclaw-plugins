/**
 * URI Extractor — Extract source URIs from tool call parameters.
 *
 * Config-driven extraction with built-in defaults for known OpenClaw tools.
 * User config only needed for custom/plugin tools.
 *
 * Extraction lookup order:
 *   1. Custom composite extractor (message.read, etc.)
 *   2. Config-driven composite extractor (browser.navigate, etc.)
 *   3. Config-driven bare tool extractor (web_fetch, Read, etc.)
 *   4. No match → []
 */

// ── Extractor config ────────────────────────────────────────────────────────

export interface UriExtractorConfig {
  /** Parameter names that contain URIs */
  params: string[];
  /** Default scheme if value has no scheme */
  scheme?: string;
  /** Per-param scheme overrides */
  schemeMap?: Record<string, string>;
}

// ── Built-in defaults ───────────────────────────────────────────────────────

/** Default URI extractors for known tools (bare tool names) */
export const DEFAULT_URI_EXTRACTORS: Record<string, UriExtractorConfig> = {
  web_fetch: { params: ["url"] },
  web_search: { params: ["query"], scheme: "brave-search" },
  Read: { params: ["file_path", "path"], scheme: "file" },
  Write: { params: ["file_path", "path"], scheme: "file" },
  Edit: { params: ["file_path", "path"], scheme: "file" },
  image: { params: ["image", "images"], scheme: "file" },
  gog: { params: ["query"], scheme: "google" },
  vestige_search: { params: ["query"], scheme: "vestige" },
  vestige_smart_ingest: { params: ["content"], scheme: "vestige" },
  vestige_ingest: { params: ["content"], scheme: "vestige" },
  vestige_promote: { params: ["memory_id"], scheme: "vestige" },
  vestige_demote: { params: ["memory_id"], scheme: "vestige" },
  memory_search: { params: ["query"], scheme: "memory" },
  memory_get: { params: ["path"], scheme: "file" },
};

/** Default URI extractors for composite keys */
export const DEFAULT_COMPOSITE_URI_EXTRACTORS: Record<
  string,
  UriExtractorConfig
> = {
  "browser.navigate": { params: ["targetUrl", "url"] },
  "browser.snapshot": { params: ["targetUrl"] },
  "browser.screenshot": { params: ["targetUrl"] },
  "browser.console": { params: ["targetUrl"] },
  "browser.pdf": { params: ["targetUrl"] },
};

// ── Custom composite extractors (message tool) ─────────────────────────────

/**
 * Extract provider-aware URI from message tool params.
 *
 * Produces URIs like:
 *   slack://C0ACUTPFSJ3/read
 *   discord://1467008598780678164/search
 *   telegram://chat:12345/read
 */
function extractMessageUri(
  params: Record<string, unknown>,
  action: string,
): string[] {
  const provider = (params.channel as string) ?? "unknown";
  const target =
    (params.target as string) ??
    (params.channelId as string) ??
    "unknown";
  return [`${provider}://${target}/${action}`];
}

/** Message actions that read data into context (need URI extraction) */
const MESSAGE_READ_ACTIONS = new Set([
  "message.read",
  "message.search",
  "message.thread-list",
  "message.thread-reply",
  "message.list-pins",
  "message.reactions",
  "message.event-list",
  "message.channel-list",
  "message.channel-info",
  "message.member-info",
  "message.role-info",
  "message.permissions",
  "message.emoji-list",
]);

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize a value into a URI with a scheme.
 *
 * - Values with an existing scheme are returned as-is
 * - Absolute paths get `file://` prepended
 * - Other values get the default scheme prepended
 */
export function normalizeUri(value: string, defaultScheme?: string): string {
  // Already has scheme (https://, file://, etc.)
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) return value;
  // Absolute path → file://
  if (value.startsWith("/")) return `file://${value}`;
  // Apply default scheme
  if (defaultScheme) return `${defaultScheme}://${value}`;
  return value;
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract URIs from tool params using a config-driven extractor.
 */
function extractFromConfig(
  params: Record<string, unknown>,
  config: UriExtractorConfig,
): string[] {
  const uris: string[] = [];
  for (const paramName of config.params) {
    const val = params[paramName];
    if (typeof val === "string" && val) {
      uris.push(
        normalizeUri(
          val,
          config.schemeMap?.[paramName] ?? config.scheme,
        ),
      );
    }
    if (Array.isArray(val)) {
      for (const v of val) {
        if (typeof v === "string" && v) {
          uris.push(
            normalizeUri(
              v,
              config.schemeMap?.[paramName] ?? config.scheme,
            ),
          );
        }
      }
    }
  }
  return uris;
}

/**
 * Extract source URIs from a tool call.
 *
 * @param toolKey   Composite key (e.g. "message.read") or bare name (e.g. "web_fetch")
 * @param bareName  The original tool name before composite resolution
 * @param params    Tool call parameters
 * @param extractors  Merged extractor config (built-in + user overrides)
 * @returns Array of normalized URIs, or empty if no extraction configured
 */
export function extractToolSourceUris(
  toolKey: string,
  bareName: string,
  params: Record<string, unknown>,
  extractors: Record<string, UriExtractorConfig>,
): string[] {
  // 1. Custom composite extractor (message tool)
  if (MESSAGE_READ_ACTIONS.has(toolKey)) {
    const action = toolKey.split(".")[1];
    if (action) return extractMessageUri(params, action);
  }

  // 2. Config-driven composite extractor
  if (extractors[toolKey]) {
    return extractFromConfig(params, extractors[toolKey]);
  }

  // 3. Config-driven bare tool extractor
  if (toolKey !== bareName && extractors[bareName]) {
    return extractFromConfig(params, extractors[bareName]);
  }

  return [];
}

// ── Merge ───────────────────────────────────────────────────────────────────

/**
 * Build the merged URI extractor map: built-in defaults + user overrides.
 */
export function buildUriExtractorMap(
  configOverrides?: Record<string, UriExtractorConfig>,
): Record<string, UriExtractorConfig> {
  return {
    ...DEFAULT_URI_EXTRACTORS,
    ...DEFAULT_COMPOSITE_URI_EXTRACTORS,
    ...(configOverrides ?? {}),
  };
}
