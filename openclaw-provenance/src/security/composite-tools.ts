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

  // ── browser: action-only (no data read) ──
  "browser.act": "trusted",
  "browser.open": "trusted",
  "browser.start": "trusted",
  "browser.stop": "trusted",
  "browser.close": "trusted",
  "browser.focus": "trusted",
  "browser.dialog": "trusted",
  "browser.upload": "trusted",

  // ── browser: reads external content ──
  "browser.navigate": "untrusted",
  "browser.snapshot": "untrusted",
  "browser.screenshot": "untrusted",
  "browser.console": "untrusted",
  "browser.pdf": "untrusted",

  // ── browser: metadata ──
  "browser.status": "shared",
  "browser.tabs": "shared",
  "browser.profiles": "shared",
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
 * Looks up the tool name in the composite tools config, extracts the
 * action parameter, and returns `toolName.action`. Falls back to bare
 * tool name if no composite config or no action param found.
 */
export function resolveToolKey(
  toolName: string,
  params: Record<string, unknown>,
  compositeTools: Record<string, CompositeToolConfig>,
): string {
  const config = compositeTools[toolName];
  if (config) {
    const action = params[config.actionParam];
    if (typeof action === "string") return `${toolName}.${action}`;
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
