/**
 * Memory File Detector — Test Suite
 */

import { describe, it, expect } from "vitest";
import { isMemoryFile } from "../memory-file-detector.js";

const WORKSPACE = "/home/user/.openclaw/workspace";

describe("isMemoryFile()", () => {
  it("detects bootstrap files", () => {
    expect(isMemoryFile(`${WORKSPACE}/SOUL.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/MEMORY.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/AGENTS.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/TOOLS.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/IDENTITY.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/USER.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/HEARTBEAT.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/BOOTSTRAP.md`, WORKSPACE)).toBe(true);
  });

  it("detects files in memory/ directory", () => {
    expect(isMemoryFile(`${WORKSPACE}/memory/2026-02-15.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile(`${WORKSPACE}/memory/heartbeat-state.json`, WORKSPACE)).toBe(true); // any file in memory/ matches
    expect(isMemoryFile(`${WORKSPACE}/memory/anything.md`, WORKSPACE)).toBe(true);
  });

  it("rejects non-memory files", () => {
    expect(isMemoryFile(`${WORKSPACE}/README.md`, WORKSPACE)).toBe(false);
    expect(isMemoryFile(`${WORKSPACE}/src/index.ts`, WORKSPACE)).toBe(false);
    expect(isMemoryFile(`${WORKSPACE}/scripts/test.sh`, WORKSPACE)).toBe(false);
  });

  it("detects bootstrap files regardless of directory", () => {
    // basename match means SOUL.md in any subdirectory matches
    expect(isMemoryFile(`${WORKSPACE}/subdir/SOUL.md`, WORKSPACE)).toBe(true);
    expect(isMemoryFile("/tmp/MEMORY.md", WORKSPACE)).toBe(true);
  });

  it("is case-sensitive on bootstrap file names", () => {
    expect(isMemoryFile(`${WORKSPACE}/soul.md`, WORKSPACE)).toBe(false);
    expect(isMemoryFile(`${WORKSPACE}/memory.md`, WORKSPACE)).toBe(true); // lowercase memory.md IS in the list
    expect(isMemoryFile(`${WORKSPACE}/agents.md`, WORKSPACE)).toBe(false);
  });
});
