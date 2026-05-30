import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OPENCLAW_CLAUDE_BRIDGE_NAME, OPENCLAW_CLAUDE_BRIDGE_VERSION } from "../src/version.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The hand-maintained src/version.ts must match package.json. 0.2.5 shipped a
 * stale version.ts (fixed by the 0.2.6 hand-patch); this test plus the
 * prepublishOnly build hook close that gap so the two sources can't drift into
 * a published release again.
 */
describe("version.ts <-> package.json sync", () => {
  const pkg = JSON.parse(readFileSync(path.resolve(HERE, "..", "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };

  it("OPENCLAW_CLAUDE_BRIDGE_VERSION equals package.json version", () => {
    expect(OPENCLAW_CLAUDE_BRIDGE_VERSION).toBe(pkg.version);
  });

  it("OPENCLAW_CLAUDE_BRIDGE_NAME equals package.json name", () => {
    expect(OPENCLAW_CLAUDE_BRIDGE_NAME).toBe(pkg.name);
  });
});
