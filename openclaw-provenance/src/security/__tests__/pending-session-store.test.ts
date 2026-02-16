/**
 * Pending Session Store — Test Suite
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PendingSessionStore } from "../pending-session-store.js";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PendingSessionStore", () => {
  let tmpDir: string;
  let store: PendingSessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pending-save-test-"));
    store = new PendingSessionStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates pending-saves directory on init", () => {
    expect(existsSync(join(tmpDir, ".provenance", "pending-saves"))).toBe(true);
  });

  it("createPending writes file and returns code", () => {
    const code = store.createPending(
      "session-1",
      "external",
      "tainted session",
      "# Session content\nHello world",
      join(tmpDir, "memory", "2026-02-15.md"),
      60_000,
    );
    expect(code).toMatch(/^[0-9a-f]{8}$/);

    const pending = store.get(code);
    expect(pending).toBeDefined();
    expect(pending!.sessionKey).toBe("session-1");
    expect(pending!.taint).toBe("external");
  });

  it("registerPending stores metadata without writing file", () => {
    const tempPath = join(tmpDir, ".provenance", "pending-saves", "test.md");
    store.registerPending(
      "abc12345",
      "session-1",
      "shared",
      "test reason",
      tempPath,
      join(tmpDir, "memory", "2026-02-15.md"),
      60_000,
    );
    const pending = store.get("abc12345");
    expect(pending).toBeDefined();
    expect(pending!.code).toBe("abc12345");
    // File should NOT exist (registerPending doesn't write it)
    expect(existsSync(tempPath)).toBe(false);
  });

  it("approve moves file from temp to final location", () => {
    const code = store.createPending(
      "session-1",
      "external",
      "tainted",
      "# Content",
      join(tmpDir, "memory", "2026-02-15.md"),
      60_000,
    );

    const result = store.approve(code);
    expect(result.ok).toBe(true);
    expect(result.finalPath).toBe(join(tmpDir, "memory", "2026-02-15.md"));
    expect(existsSync(join(tmpDir, "memory", "2026-02-15.md"))).toBe(true);
    // Pending should be removed
    expect(store.get(code)).toBeUndefined();
  });

  it("approve rejects invalid code", () => {
    const result = store.approve("invalid1");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Invalid");
  });

  it("approve rejects expired code", () => {
    const tempPath = join(tmpDir, ".provenance", "pending-saves", "expired.md");
    writeFileSync(tempPath, "content", "utf-8");
    store.registerPending(
      "expired1",
      "session-1",
      "external",
      "test",
      tempPath,
      join(tmpDir, "memory", "final.md"),
      -1, // already expired
    );

    const result = store.approve("expired1");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("expired");
    // Temp file should be cleaned up
    expect(existsSync(tempPath)).toBe(false);
  });

  it("clearAll removes all pending saves and their temp files", () => {
    const code1 = store.createPending(
      "s1", "external", "r1", "content1",
      join(tmpDir, "memory", "f1.md"), 60_000,
    );
    const code2 = store.createPending(
      "s2", "shared", "r2", "content2",
      join(tmpDir, "memory", "f2.md"), 60_000,
    );

    const count = store.clearAll();
    expect(count).toBe(2);
    expect(store.get(code1)).toBeUndefined();
    expect(store.get(code2)).toBeUndefined();
  });

  it("getAll returns all pending saves", () => {
    store.createPending("s1", "external", "r1", "c1", "/tmp/f1", 60_000);
    store.createPending("s2", "shared", "r2", "c2", "/tmp/f2", 60_000);
    expect(store.getAll()).toHaveLength(2);
  });

  it("cleanup removes only expired entries", () => {
    const tempPath = join(tmpDir, ".provenance", "pending-saves", "old.md");
    writeFileSync(tempPath, "old", "utf-8");
    store.registerPending("old1", "s1", "external", "old", tempPath, "/tmp/f", -1);
    store.createPending("s2", "shared", "fresh", "new", "/tmp/f2", 60_000);

    store.cleanup();
    expect(store.getAll()).toHaveLength(1); // only the fresh one
    expect(existsSync(tempPath)).toBe(false);
  });
});
