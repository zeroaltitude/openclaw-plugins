/**
 * Plugin tool inventory shape + deterministic fingerprint.
 *
 * Captures the names + signatures of the plugin tools active at a moment
 * in time so per-thread storage can detect catalog drift between turns.
 * Codex uses the same split (plugin-inventory.ts captures, plugin-thread-config.ts
 * stores + validates) for parity.
 *
 * Pure helpers; no I/O.
 */

import { createHash } from "node:crypto";
import type { DynamicToolSpec } from "./protocol.js";

export type PluginToolEntry = {
  name: string;
  /**
   * Signature: a stable hash of (description, inputSchema, deferLoading,
   * alwaysLoad). Changing the description or the input schema invalidates
   * the signature, which lets resume detect tool-shape drift even when
   * the tool name is unchanged.
   */
  signature: string;
};

export type PluginInventory = {
  entries: PluginToolEntry[];
  /**
   * Deterministic hash over the inventory. Stable across runs so two
   * inventories with the same entries (in any order) produce the same
   * fingerprint.
   */
  fingerprint: string;
};

export function capturePluginInventory(tools: readonly DynamicToolSpec[]): PluginInventory {
  const entries: PluginToolEntry[] = tools.map((t) => ({
    name: t.name,
    signature: signatureForTool(t),
  }));
  // Sort by name so the inventory is order-stable (toolNames may arrive in
  // any order from MCP discovery).
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, fingerprint: fingerprintInventoryEntries(entries) };
}

export function fingerprintInventoryEntries(entries: readonly PluginToolEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const payload = sorted.map((e) => `${e.name}:${e.signature}`).join("\n");
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function signatureForTool(tool: DynamicToolSpec): string {
  // Stable JSON serialization (keys sorted) so trivially-equivalent shapes
  // produce equal signatures.
  const payload = stableStringify({
    description: tool.description,
    inputSchema: tool.inputSchema,
    deferLoading: tool.deferLoading ?? false,
    alwaysLoad: tool.alwaysLoad ?? false,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
