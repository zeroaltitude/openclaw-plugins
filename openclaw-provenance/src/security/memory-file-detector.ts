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

  try {
    const relPath = relative(workspaceDir, filePath);
    const isInsideWorkspace = !relPath.startsWith("..");

    // Check if it's a bootstrap file within (or at the root of) the workspace
    if (isInsideWorkspace && BOOTSTRAP_FILES.includes(fileName)) {
      return true;
    }

    // Check if it's in memory/ directory (within workspace)
    // Handle both forward and backslash (Windows compatibility)
    if (relPath.startsWith("memory/") || relPath.startsWith("memory\\")) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
