/**
 * Config Writer — Provenance Plugin Config Persistence
 *
 * Reads and writes the provenance plugin config subtree in openclaw.json.
 * Used by /approve, /trust-uri, and /trust-tool commands to persist changes
 * across gateway restarts.
 *
 * Writes only the `plugins.entries.provenance.config` subtree — never
 * touching unrelated config keys. Uses JSON merge (deep merge at the
 * plugin config level only).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TrustLevel } from "./trust-levels.js";
import type { PolicyMode, ToolOverride } from "./policy-engine.js";

// ── Config path resolution ──────────────────────────────────────────────────

function resolveOpenClawConfigPath(): string {
  const override = process.env["OPENCLAW_CONFIG_PATH"]?.trim();
  if (override) return override;
  return join(homedir(), ".openclaw", "openclaw.json");
}

// ── Plugin config subtree types ─────────────────────────────────────────────

export interface ProvenancePluginConfig {
  uriTrust?: Record<string, TrustLevel>;
  toolOutputTaints?: Record<string, TrustLevel>;
  toolOverrides?: Record<string, ToolOverride>;
  [key: string]: unknown;
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Read the current provenance plugin config from openclaw.json.
 * Returns an empty object if not found.
 */
export function readProvenanceConfig(): ProvenancePluginConfig {
  const configPath = resolveOpenClawConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed?.plugins?.entries?.provenance?.config as ProvenancePluginConfig) ?? {};
  } catch {
    return {};
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Write a partial update to the provenance plugin config subtree.
 * Deep-merges at the plugin config level — does not touch other config keys.
 */
export function writeProvenanceConfig(
  patch: Partial<ProvenancePluginConfig>,
): void {
  const configPath = resolveOpenClawConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`openclaw.json not found at ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  // Ensure the path exists
  parsed.plugins ??= {};
  parsed.plugins.entries ??= {};
  parsed.plugins.entries.provenance ??= {};
  parsed.plugins.entries.provenance.config ??= {};

  const current = parsed.plugins.entries.provenance.config as ProvenancePluginConfig;

  // Deep merge only the patched keys
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      delete current[key];
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof current[key] === "object" &&
      current[key] !== null &&
      !Array.isArray(current[key])
    ) {
      // Merge object-valued keys (e.g., uriTrust, toolOverrides)
      current[key] = { ...(current[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      current[key] = value;
    }
  }

  writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf-8");
}

/**
 * Delete specific keys from a record field in the provenance plugin config.
 * Used by /trust-uri remove and /trust-tool remove.
 */
export function deleteProvenanceConfigKeys(
  field: keyof ProvenancePluginConfig,
  keys: string[],
): void {
  const configPath = resolveOpenClawConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`openclaw.json not found at ${configPath}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  const current =
    parsed?.plugins?.entries?.provenance?.config?.[field] as
      | Record<string, unknown>
      | undefined;

  if (!current) return; // Nothing to delete

  for (const key of keys) {
    delete current[key];
  }

  // Write back
  parsed.plugins.entries.provenance.config[field] = current;
  writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf-8");
}
