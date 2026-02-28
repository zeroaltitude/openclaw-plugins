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

import type { TrustLevel } from "./trust-levels.js";
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
  "browser.screenshot": "external",
  "browser.console": "external",
  "browser.pdf": "external",

  // ── browser: local introspection (own browser state, no external data) ──
  "browser.status": "trusted",
  "browser.tabs": "trusted",
  "browser.profiles": "trusted",

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
};

// ── Resolution functions ────────────────────────────────────────────────────

/**
 * Resolve a tool call to its composite key.
 *
 * Resolution order:
 *   1. Composite tools (action parameter) — e.g., browser.navigate, message.send
 *   2. Exec command pattern matching — e.g., exec.curl, exec.agent-browser-snapshot
 *   3. Fall through to bare tool name
 */
export function resolveToolKey(
  toolName: string,
  params: Record<string, unknown>,
  compositeTools: Record<string, CompositeToolConfig>,
  execCommandRules?: ExecCommandRule[],
): string {
  // 1. Standard composite tool resolution (action param)
  const config = compositeTools[toolName];
  if (config) {
    const action = params[config.actionParam];
    if (typeof action === "string") return `${toolName}.${action}`;
  }

  // 2. Exec command pattern matching
  if (toolName === "exec") {
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
