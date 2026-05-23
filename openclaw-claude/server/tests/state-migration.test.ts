/**
 * Tests for the one-shot rename of `<openclaw>/state/claude-app-server`
 * → `<openclaw>/state/claude-bridge` that fires on server boot when
 * existing user installs predate the package rename.
 *
 * Tank's 2026-05-22 task-list item #7 — legacy state migration was added
 * alongside the @zeroaltitude/claude-app-server → @zeroaltitude/openclaw-claude-bridge
 * rename and needs explicit coverage so regressions can't silently
 * orphan existing user thread bindings.
 *
 * `runLegacyStateRootMigration` is the path-injectable form of
 * `migrateLegacyStateRootIfNeeded` — these tests exercise the rename
 * mechanics in isolation; the public wrapper just gates on the
 * canonical DEFAULT_STATE_ROOT.
 */

import { mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STATE_ROOT,
  LEGACY_CLAUDE_APP_SERVER_STATE_ROOT,
  migrateLegacyStateRootIfNeeded,
  runLegacyStateRootMigration,
} from "../src/thread-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("runLegacyStateRootMigration", () => {
  it("is a no-op when the legacy directory does not exist", async () => {
    const root = await makeRoot("openclaw-mig-noop-");
    const legacyPath = path.join(root, "claude-app-server");
    const newPath = path.join(root, "claude-bridge");
    const logger = makeLogger();
    await runLegacyStateRootMigration({ legacyPath, newPath }, logger);
    expect(await pathExists(legacyPath)).toBe(false);
    expect(await pathExists(newPath)).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("renames legacy → new when only legacy exists, preserving contents", async () => {
    const root = await makeRoot("openclaw-mig-rename-");
    const legacyPath = path.join(root, "claude-app-server");
    const newPath = path.join(root, "claude-bridge");
    await mkdir(path.join(legacyPath, "threads", "thr_demo"), { recursive: true });
    await writeFile(
      path.join(legacyPath, "threads", "thr_demo", "meta.json"),
      JSON.stringify({ id: "thr_demo", sample: true }),
    );
    await writeFile(path.join(legacyPath, "threads", "thr_demo", "messages.jsonl"), "line1\nline2\n");
    const logger = makeLogger();

    await runLegacyStateRootMigration({ legacyPath, newPath }, logger);

    expect(await pathExists(legacyPath)).toBe(false);
    expect(await pathExists(newPath)).toBe(true);
    // Contents survive the rename.
    const movedMeta = JSON.parse(
      await readFile(path.join(newPath, "threads", "thr_demo", "meta.json"), "utf8"),
    ) as { id: string; sample: boolean };
    expect(movedMeta).toEqual({ id: "thr_demo", sample: true });
    expect(await readFile(path.join(newPath, "threads", "thr_demo", "messages.jsonl"), "utf8")).toBe(
      "line1\nline2\n",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`state-dir migration: ${legacyPath} -> ${newPath}`),
    );
  });

  it("creates the new path's parent directory if missing", async () => {
    const root = await makeRoot("openclaw-mig-parent-");
    const legacyPath = path.join(root, "claude-app-server");
    const newPath = path.join(root, "nested", "deeper", "claude-bridge");
    await mkdir(legacyPath, { recursive: true });
    await writeFile(path.join(legacyPath, "marker"), "x");
    const logger = makeLogger();

    await runLegacyStateRootMigration({ legacyPath, newPath }, logger);

    expect(await pathExists(newPath)).toBe(true);
    expect(await readFile(path.join(newPath, "marker"), "utf8")).toBe("x");
  });

  it("logs a warning and leaves both paths untouched when both already exist", async () => {
    const root = await makeRoot("openclaw-mig-both-");
    const legacyPath = path.join(root, "claude-app-server");
    const newPath = path.join(root, "claude-bridge");
    await mkdir(legacyPath, { recursive: true });
    await writeFile(path.join(legacyPath, "legacy-marker"), "L");
    await mkdir(newPath, { recursive: true });
    await writeFile(path.join(newPath, "new-marker"), "N");
    const logger = makeLogger();

    await runLegacyStateRootMigration({ legacyPath, newPath }, logger);

    expect(await pathExists(legacyPath)).toBe(true);
    expect(await pathExists(newPath)).toBe(true);
    expect(await readFile(path.join(legacyPath, "legacy-marker"), "utf8")).toBe("L");
    expect(await readFile(path.join(newPath, "new-marker"), "utf8")).toBe("N");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not migrating (resolve manually)"),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("does not require a logger", async () => {
    const root = await makeRoot("openclaw-mig-no-logger-");
    const legacyPath = path.join(root, "claude-app-server");
    const newPath = path.join(root, "claude-bridge");
    await mkdir(legacyPath, { recursive: true });
    await expect(runLegacyStateRootMigration({ legacyPath, newPath })).resolves.not.toThrow();
    expect(await pathExists(newPath)).toBe(true);
  });
});

describe("migrateLegacyStateRootIfNeeded (gate on canonical stateRoot)", () => {
  it("returns silently when the stateRoot is not the canonical default", async () => {
    const customRoot = await makeRoot("openclaw-state-custom-");
    const logger = makeLogger();
    await migrateLegacyStateRootIfNeeded(customRoot, logger);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not throw when called on the canonical default (legacy may or may not exist)", async () => {
    const logger = makeLogger();
    await expect(migrateLegacyStateRootIfNeeded(DEFAULT_STATE_ROOT, logger)).resolves.not.toThrow();
  });

  it("LEGACY_CLAUDE_APP_SERVER_STATE_ROOT and DEFAULT_STATE_ROOT live under the same base", () => {
    expect(path.dirname(LEGACY_CLAUDE_APP_SERVER_STATE_ROOT)).toBe(path.dirname(DEFAULT_STATE_ROOT));
    expect(path.basename(LEGACY_CLAUDE_APP_SERVER_STATE_ROOT)).toBe("claude-app-server");
    expect(path.basename(DEFAULT_STATE_ROOT)).toBe("claude-bridge");
  });
});
