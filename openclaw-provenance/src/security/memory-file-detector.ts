/**
 * Memory File Detector
 *
 * Detects writes to memory and bootstrap files that persist across turns
 * and could be poisoned by tainted content.
 */

import { basename, relative } from "node:path";

/**
 * Bootstrap files that load into system prompt or are indexed as memory.
 * Based on OpenClaw's workspace.ts defaults.
 */
const BOOTSTRAP_FILES = [
  "SOUL.md",
  "MEMORY.md",
  "memory.md",
  "AGENTS.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

/**
 * Check if a file path is a memory or bootstrap file.
 * Returns true for:
 * - Any of the BOOTSTRAP_FILES (SOUL.md, MEMORY.md, etc.)
 * - Any .md file in memory/ directory
 *
 * @param filePath - Absolute path to the file being written
 * @param workspaceDir - Workspace root directory
 */
export function isMemoryFile(filePath: string, workspaceDir: string): boolean {
  const fileName = basename(filePath);

  // Check if it's a bootstrap file
  if (BOOTSTRAP_FILES.includes(fileName)) {
    return true;
  }

  // Check if it's in memory/ directory
  try {
    const relPath = relative(workspaceDir, filePath);
    // Handle both forward and backslash (Windows compatibility)
    return relPath.startsWith("memory/") || relPath.startsWith("memory\\");
  } catch {
    return false;
  }
}
