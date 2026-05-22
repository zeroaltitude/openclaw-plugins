/**
 * Per-thread plugin config + resume validation.
 *
 * Pairs with plugin-inventory.ts: the inventory captures what tools were
 * available at thread/start; this module compares a current inventory
 * against the stored one and emits a structured diff that resume can use
 * to (a) rotate to a fresh thread when the set has drifted incompatibly,
 * (b) warn the user about specific tool changes instead of producing
 * opaque mid-turn "tool not found" errors.
 *
 * Mirrors codex/app-server/plugin-thread-config.ts at the diff/validate
 * surface; integration into the actual resume path is intentionally left
 * to the caller so this module stays pure.
 */

import type { PluginInventory, PluginToolEntry } from "./plugin-inventory.js";

export type ThreadPluginConfig = {
  schemaVersion: 1;
  capturedAt: number;
  inventory: PluginInventory;
};

export type PluginInventoryDiff = {
  /** Tools present in `current` but absent in `stored`. */
  added: PluginToolEntry[];
  /** Tools present in `stored` but absent in `current` (the resume-risk set). */
  removed: PluginToolEntry[];
  /** Tools present in both but whose signature has changed (schema drift). */
  signatureChanged: { name: string; storedSignature: string; currentSignature: string }[];
  /** True if added.length + removed.length + signatureChanged.length === 0. */
  identical: boolean;
};

export function captureThreadPluginConfig(inventory: PluginInventory): ThreadPluginConfig {
  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    inventory,
  };
}

export function diffPluginInventories(
  stored: PluginInventory,
  current: PluginInventory,
): PluginInventoryDiff {
  const storedByName = new Map(stored.entries.map((e) => [e.name, e]));
  const currentByName = new Map(current.entries.map((e) => [e.name, e]));

  const added: PluginToolEntry[] = [];
  for (const entry of current.entries) {
    if (!storedByName.has(entry.name)) {
      added.push(entry);
    }
  }

  const removed: PluginToolEntry[] = [];
  for (const entry of stored.entries) {
    if (!currentByName.has(entry.name)) {
      removed.push(entry);
    }
  }

  const signatureChanged: PluginInventoryDiff["signatureChanged"] = [];
  for (const entry of current.entries) {
    const previous = storedByName.get(entry.name);
    if (previous && previous.signature !== entry.signature) {
      signatureChanged.push({
        name: entry.name,
        storedSignature: previous.signature,
        currentSignature: entry.signature,
      });
    }
  }

  const identical = added.length === 0 && removed.length === 0 && signatureChanged.length === 0;
  return { added, removed, signatureChanged, identical };
}

/**
 * Categorize a resume attempt against a stored plugin config.
 *
 * Resume safety classification:
 *   - "safe":       inventories are identical, or current is a SUPERSET
 *                   (added tools only, no removals or signature changes).
 *                   The thread can resume against a strictly richer
 *                   catalog without the model encountering missing tools.
 *   - "unsafe":     removed or signature-changed tools exist. Resuming
 *                   may produce mid-turn "tool not found" or schema
 *                   mismatch errors. Caller should rotate to a new thread.
 */
export type ResumeCompatibility = {
  level: "safe" | "unsafe";
  diff: PluginInventoryDiff;
  reason?: string;
};

export function classifyResumeCompatibility(
  stored: PluginInventory,
  current: PluginInventory,
): ResumeCompatibility {
  const diff = diffPluginInventories(stored, current);
  if (diff.identical || (diff.removed.length === 0 && diff.signatureChanged.length === 0)) {
    return { level: "safe", diff };
  }
  const removedNames = diff.removed.map((e) => e.name);
  const changedNames = diff.signatureChanged.map((e) => e.name);
  const segments: string[] = [];
  if (removedNames.length > 0) {
    segments.push(`removed: ${removedNames.join(", ")}`);
  }
  if (changedNames.length > 0) {
    segments.push(`signature changed: ${changedNames.join(", ")}`);
  }
  return {
    level: "unsafe",
    diff,
    reason: `plugin tool drift since thread/start (${segments.join("; ")})`,
  };
}
