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

import { TabUrlStore, getSharedTabUrlStore, type TabLike } from "./tab-url-store.js";

// ── Extractor config ────────────────────────────────────────────────────────

export interface UriExtractorConfig {
  /** Parameter names that contain URIs */
  params: string[];
  /** Default scheme if value has no scheme */
  scheme?: string;
  /** Scheme to use for API-style absolute paths such as /api/v1/tweets */
  absolutePathScheme?: string;
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
  // view_image: Codex's OWN native tool only accepts a local `path` (see the
  // "view_image" comment in trust-levels.ts) — same category as Read above,
  // same file:// extraction. OpenClaw's separate view_image MCP tool CAN
  // carry a remote URL; this extraction is what catches that case and lets
  // uri-trust correctly override the "trusted" default down to "external"
  // via the built-in https://** catch-all, exactly like webrun.
  view_image: { params: ["path", "paths"], scheme: "file" },
  gog: { params: ["query"], scheme: "google" },
  // vestige_search intentionally omitted — local cognitive memory, trusted
  // by default. The vestige:// URI pattern ("shared") would override the
  // tool output taint ("trusted"), same issue as vestige write ops.
  // vestige write ops also intentionally omitted — content is going OUT, not
  // coming IN. Extracting a URI from the content param would cause the
  // vestige://** URI trust pattern ("shared") to override the tool output
  // taint ("trusted"), incorrectly tainting write-only operations.
  // memory_search intentionally omitted — local workspace memory files,
  // trusted by default. Same rationale as vestige_search: the memory://
  // URI pattern ("shared") would incorrectly taint a trusted local tool.
  memory_get: { params: ["path"], scheme: "file" },
};

/** Default URI extractors for composite keys */
export const DEFAULT_COMPOSITE_URI_EXTRACTORS: Record<
  string,
  UriExtractorConfig
> = {
  "browser.navigate": { params: ["targetUrl", "url"] },
  "browser.open": { params: ["targetUrl", "url"] },
  // snapshot/screenshot/console/pdf operate on existing tabs via targetId,
  // not URLs. URI resolution handled by tab URL tracking fallback in
  // extractToolSourceUris (targetId → URL via recordTabUrls).
  // Also accept url/targetUrl as fallback — some MCP browser servers
  // include the URL directly alongside targetId in params.
  // "tabId" is listed alongside targetId because the tool schema's own
  // description tells agents to *prefer* passing a tabId-style handle
  // (e.g. "t1") as the targetId value — see browser-tool.schema.ts's
  // TAB_REFERENCE_DESCRIPTION. No current client puts that value under a
  // literal `tabId` param, but accepting it here is cheap and future-proofs
  // against clients/MCP bridges that do.
  "browser.snapshot": { params: ["targetId", "tabId", "url", "targetUrl"] },
  "browser.screenshot": { params: ["targetId", "tabId", "url", "targetUrl"] },
  "browser.console": { params: ["targetId", "tabId", "url", "targetUrl"] },
  "browser.pdf": { params: ["targetId", "tabId", "url", "targetUrl"] },
};

// ── Browser tab URL tracking ────────────────────────────────────────────────

/**
 * Track browser tab URLs so that subsequent calls referencing a tab by
 * targetId (or by a tabId/label alias — see DEFAULT_COMPOSITE_URI_EXTRACTORS
 * comment above) can still resolve to a URI for trust classification.
 *
 * Backed by TabUrlStore, which persists to <workspaceDir>/.provenance/
 * tab-urls.json so aliases survive gateway restarts. Call
 * initTabUrlPersistence(workspaceDir) once at plugin registration to point
 * this at a workspace; until then it operates purely in-memory.
 */
let activeTabUrlStore: TabUrlStore = new TabUrlStore();

/** Point tab URL tracking at a workspace's on-disk store (survives restarts). */
export function initTabUrlPersistence(workspaceDir: string): void {
  activeTabUrlStore = getSharedTabUrlStore(workspaceDir);
}

/** Record tab URLs from a browser.tabs/open/navigate response */
export function recordTabUrls(tabs: TabLike[]): void {
  activeTabUrlStore.recordTabs(tabs);
}

/** Resolve a targetId or tabId/label alias to a URL if known from prior browser calls */
export function resolveTabUrl(targetId: string): string | undefined {
  return activeTabUrlStore.resolveTabUrl(targetId);
}

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
  // channel-list is a target-less listing operation — no resource URI to extract.
  // Its tool trust ("shared" by default) stands without URI override.
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
export function normalizeUri(
  value: string,
  defaultScheme?: string,
  absolutePathScheme?: string,
): string {
  // Already has scheme (https://, file://, etc.)
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) return value;
  // API path params can opt into a virtual scheme instead of file://.
  if (value.startsWith("/") && absolutePathScheme) {
    return `${absolutePathScheme}://${value.replace(/^\/+/, "")}`;
  }
  // Absolute path → file://
  if (value.startsWith("/")) return `file://${value}`;
  // Apply default scheme
  if (defaultScheme) return `${defaultScheme}://${value}`;
  return value;
}

// ── Exec command URI extraction ─────────────────────────────────────────────

import { extractExecUris, type ExecCommandRule } from "./exec-command-taint.js";

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
          config.absolutePathScheme,
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
              config.absolutePathScheme,
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
  execCommandRules?: ExecCommandRule[],
): string[] {
  // 0. Exec command pattern-based URI extraction
  if (bareName === "exec" && toolKey.startsWith("exec.")) {
    return extractExecUris(params, execCommandRules);
  }

  // 1. Custom composite extractor (message tool)
  if (MESSAGE_READ_ACTIONS.has(toolKey)) {
    const action = toolKey.split(".")[1];
    if (action) return extractMessageUri(params, action);
  }

  // 2. Config-driven composite extractor
  if (extractors[toolKey]) {
    const uris = extractFromConfig(params, extractors[toolKey]);
    // For browser tools: resolve targetId values to actual URLs via tab tracking.
    // The extractor pulls the raw targetId; we translate it to the tab's URL
    // so URI trust classification can match domain patterns.
    if (toolKey.startsWith("browser.") && uris.length > 0) {
      const resolved: string[] = [];
      for (const uri of uris) {
        // If this looks like a tab ID (not a URL), resolve it
        if (!uri.includes("://")) {
          const tabUrl = resolveTabUrl(uri);
          if (tabUrl) resolved.push(tabUrl);
          // If tab URL unknown, drop it — can't classify an opaque ID
        } else {
          resolved.push(uri);
        }
      }
      return resolved;
    }
    // Fallback: if no URI extracted but a tab reference is present, try tab
    // URL resolution directly. targetId is the field every client actually
    // sends; tabId is checked too in case a client sends the alias under
    // its own name instead of packing it into targetId.
    if (uris.length === 0 && toolKey.startsWith("browser.")) {
      const tabRef =
        typeof params.targetId === "string"
          ? params.targetId
          : typeof params.tabId === "string"
            ? params.tabId
            : undefined;
      if (tabRef) {
        const tabUrl = resolveTabUrl(tabRef);
        if (tabUrl) return [tabUrl];
      }
    }
    return uris;
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
