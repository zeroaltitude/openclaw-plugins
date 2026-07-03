/**
 * Composite Tool Key Resolution
 *
 * Tools like `message` and `browser` bundle many operations under one name.
 * This module resolves tool calls into composite keys (e.g., `message.send`,
 * `browser.navigate`) by inspecting a declared action parameter.
 *
 * Built-in defaults for known OpenClaw tools ship with the plugin.
 * User/plugin config only needed for custom tools.
 */

import { type TrustLevel, stripKnownMcpPrefix } from "./trust-levels.js";
import type { PolicyMode, ToolOverride } from "./policy-engine.js";
import {
  type ExecCommandRule,
  resolveExecToolKey,
  buildExecOutputTaints,
  DEFAULT_EXEC_COMMAND_RULES,
} from "./exec-command-taint.js";

// ── Composite tool config ───────────────────────────────────────────────────

export interface CompositeToolConfig {
  actionParam: string;
}

/** Built-in composite tool definitions — no user config needed */
export const DEFAULT_COMPOSITE_TOOLS: Record<string, CompositeToolConfig> = {
  message: { actionParam: "action" },
  browser: { actionParam: "action" },
};

// ── Composite output taints ─────────────────────────────────────────────────

/** Built-in output taint classifications for composite tool keys */
export const DEFAULT_COMPOSITE_OUTPUT_TAINTS: Record<string, TrustLevel> = {
  // ── message: output-only actions (no data incorporated) ──
  "message.send": "trusted",
  "message.react": "trusted",
  "message.pin": "trusted",
  "message.unpin": "trusted",
  "message.edit": "trusted",
  "message.delete": "trusted",
  "message.poll": "trusted",
  "message.emoji-upload": "trusted",
  "message.sticker-upload": "trusted",
  // upload-file pushes a LOCAL file out to a channel; its output is a delivery
  // receipt (message id + channel id), not inbound external content — same
  // category as message.send / emoji-upload above. Without this entry the key
  // falls through to the unknown-tool "untrusted" default, which silently
  // taints the session every time the agent uploads (a chart, a report, etc.)
  // and then gates further message ops. (Sibling of the send/* output actions.)
  "message.upload-file": "trusted",
  "message.sticker": "trusted",
  "message.set-presence": "trusted",
  "message.voice-status": "trusted",
  "message.channel-create": "trusted",
  "message.channel-edit": "trusted",
  "message.channel-delete": "trusted",
  "message.channel-move": "trusted",
  "message.category-create": "trusted",
  "message.category-edit": "trusted",
  "message.category-delete": "trusted",
  "message.event-create": "trusted",
  "message.thread-create": "trusted",

  // ── message: read actions (incorporate external data) ──
  "message.read": "external",
  "message.search": "external",
  "message.thread-list": "external",
  "message.thread-reply": "external",
  "message.list-pins": "external",
  "message.reactions": "external",
  "message.event-list": "external",

  // ── message: metadata (shared, not message content) ──
  "message.channel-list": "shared",
  "message.channel-info": "shared",
  "message.member-info": "shared",
  "message.role-info": "shared",
  "message.permissions": "shared",
  "message.emoji-list": "shared",

  // ── browser: control actions (no external data incorporated) ──
  "browser.act": "trusted",
  "browser.open": "trusted",
  "browser.start": "trusted",
  "browser.stop": "trusted",
  "browser.close": "trusted",
  "browser.focus": "trusted",
  "browser.dialog": "trusted",
  "browser.upload": "trusted",

  // ── browser: reads external page content ──
  // URI trust config can override these per-domain (e.g., docs.openclaw.ai → trusted)
  "browser.navigate": "external",
  "browser.snapshot": "external",
  "browser.screenshot": "trusted",
  "browser.console": "external",
  "browser.pdf": "external",

  // ── browser: local introspection (own browser state, no external data) ──
  "browser.status": "trusted",
  "browser.tabs": "trusted",
  "browser.profiles": "trusted",

  // ── local read tools: principle "trust what we have" ──
  // These tools read from the local workspace or internal memory — they
  // cannot introduce external content. Always trusted regardless of path.
  "read": "trusted",
  "write": "trusted",
  "edit": "trusted",
  "memory_search": "trusted",
  "memory_get": "trusted",
  "vestige_search": "trusted",
  "vestige_smart_ingest": "trusted",
  "vestige_ingest": "trusted",
  "vestige_promote": "trusted",
  "vestige_demote": "trusted",
  "vestige_dream": "trusted",
  "vestige_consolidate": "trusted",
  "vestige_importance_score": "trusted",
  "vestige_explore_connections": "trusted",
  "vestige_predict": "trusted",
  "vestige_session_context": "trusted",
  "image": "trusted",
  "pdf": "trusted",
  "canvas": "trusted",
  "tts": "trusted",
  "session_status": "trusted",
  "sessions_list": "trusted",
  "sessions_history": "trusted",
  "cron": "trusted",

  // ── exec: command-pattern-based taints (generated from exec command rules) ──
  ...buildExecOutputTaints(),
};

// ── Composite execution policy defaults ─────────────────────────────────────

/** Built-in execution policy overrides for composite keys */
export const DEFAULT_COMPOSITE_TOOL_OVERRIDES: Record<string, ToolOverride> = {
  // Agent must always be able to reply and react
  "message.send": {
    trusted: "allow",
    shared: "allow",
    external: "allow",
    untrusted: "allow",
  },
  "message.react": {
    trusted: "allow",
    shared: "allow",
    external: "allow",
    untrusted: "allow",
  },

  // ── message: read/metadata actions are INPUT operations ──────────────────
  // Reading a channel, searching, listing threads/pins/reactions, or fetching
  // channel/member metadata pulls data INTO context — it cannot exfiltrate.
  // Gating these at `external` (via the bare `message` policy) breaks any
  // workflow that must read more than one non-allowlisted channel: the first
  // read taints the session `external` (built-in `slack://** → external`),
  // and every subsequent read is then blocked — e.g. the morning-briefing
  // cron could never finish gathering (openclaw-provenance-hce).
  //
  // Mirror the web_fetch/web_search execution policy: allow up to `external`,
  // restrict only at `untrusted` (guards against attacker-directed second-
  // stage payload fetches). This is strictly consistent with message.send
  // already being allowed at every level — the send path is the real exfil
  // vector, and it is intentionally open, so gating pure reads adds no
  // protection while blocking legitimate work.
  "message.read":        { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.search":      { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.thread-list": { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.list-pins":   { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.reactions":   { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.event-list":  { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  // Channel/member metadata (no message content) — same input-only rationale.
  "message.channel-list": { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.channel-info": { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.member-info":  { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.role-info":    { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.permissions":  { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
  "message.emoji-list":   { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
};

// ── Resolution functions ────────────────────────────────────────────────────

/**
 * Resolve a tool call to its composite key.
 *
 * Resolution order:
 *   1. Composite tools (action parameter) — e.g., browser.navigate, message.send
 *   2. Exec command pattern matching — e.g., exec.curl, exec.agent-browser-snapshot
 *   3. Fall through to bare tool name
 *
 * Composite/exec tools may arrive MCP-namespaced when routed through the
 * OpenClaw bridge (e.g. `mcp__openclaw__message`). We strip the recognized
 * prefix before resolution so subtool keys still resolve — otherwise every
 * bridge-routed `message`/`browser`/`exec` op would collapse to the bare tool's
 * external/trusted default, losing the send-vs-read (and exec command-pattern)
 * taint distinction.
 */
export function resolveToolKey(
  toolName: string,
  params: Record<string, unknown>,
  compositeTools: Record<string, CompositeToolConfig>,
  execCommandRules?: ExecCommandRule[],
): string {
  // Strip a recognized MCP prefix only when the bare name is a known composite
  // or exec tool — avoids mis-applying OpenClaw semantics to unrelated MCP
  // tools that happen to share a name.
  const stripped = stripKnownMcpPrefix(toolName);
  const baseName =
    stripped && (compositeTools[stripped] || stripped === "exec")
      ? stripped
      : toolName;

  // 1. Standard composite tool resolution (action param)
  const config = compositeTools[baseName];
  if (config) {
    const action = params[config.actionParam];
    if (typeof action === "string") return `${baseName}.${action}`;
  }

  // 2. Exec command pattern matching
  if (baseName === "exec") {
    return resolveExecToolKey(params, execCommandRules);
  }

  return toolName;
}

/**
 * Build the merged composite tools map: built-in defaults + user overrides.
 */
export function buildCompositeToolMap(
  configOverrides?: Record<string, CompositeToolConfig>,
): Record<string, CompositeToolConfig> {
  return { ...DEFAULT_COMPOSITE_TOOLS, ...(configOverrides ?? {}) };
}
