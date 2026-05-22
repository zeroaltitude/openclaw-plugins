import { describe, expect, it } from "vitest";
import { capturePluginInventory } from "../src/plugin-inventory.js";
import {
  captureThreadPluginConfig,
  classifyResumeCompatibility,
  diffPluginInventories,
} from "../src/plugin-thread-config.js";
import type { DynamicToolSpec } from "../src/protocol.js";

function tool(name: string, version: string = "v1"): DynamicToolSpec {
  return {
    name,
    description: `${name} ${version}`,
    inputSchema: { type: "object", properties: {} },
  } as DynamicToolSpec;
}

describe("captureThreadPluginConfig", () => {
  it("stamps schemaVersion + capturedAt and embeds inventory", () => {
    const inventory = capturePluginInventory([tool("a"), tool("b")]);
    const before = Date.now();
    const cfg = captureThreadPluginConfig(inventory);
    const after = Date.now();
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.capturedAt).toBeGreaterThanOrEqual(before);
    expect(cfg.capturedAt).toBeLessThanOrEqual(after);
    expect(cfg.inventory).toBe(inventory);
  });
});

describe("diffPluginInventories", () => {
  it("reports identical when both inventories match", () => {
    const a = capturePluginInventory([tool("x"), tool("y")]);
    const b = capturePluginInventory([tool("x"), tool("y")]);
    const diff = diffPluginInventories(a, b);
    expect(diff.identical).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.signatureChanged).toEqual([]);
  });

  it("reports added tools (superset)", () => {
    const stored = capturePluginInventory([tool("x")]);
    const current = capturePluginInventory([tool("x"), tool("y")]);
    const diff = diffPluginInventories(stored, current);
    expect(diff.identical).toBe(false);
    expect(diff.added.map((e) => e.name)).toEqual(["y"]);
    expect(diff.removed).toEqual([]);
  });

  it("reports removed tools", () => {
    const stored = capturePluginInventory([tool("x"), tool("y")]);
    const current = capturePluginInventory([tool("x")]);
    const diff = diffPluginInventories(stored, current);
    expect(diff.removed.map((e) => e.name)).toEqual(["y"]);
    expect(diff.added).toEqual([]);
  });

  it("reports signature changes for same-name tools", () => {
    const stored = capturePluginInventory([tool("x", "v1")]);
    const current = capturePluginInventory([tool("x", "v2")]);
    const diff = diffPluginInventories(stored, current);
    expect(diff.signatureChanged).toHaveLength(1);
    expect(diff.signatureChanged[0]?.name).toBe("x");
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("combines added + removed + signatureChanged in one pass", () => {
    const stored = capturePluginInventory([tool("a", "v1"), tool("b"), tool("c")]);
    const current = capturePluginInventory([tool("a", "v2"), tool("c"), tool("d")]);
    const diff = diffPluginInventories(stored, current);
    expect(diff.added.map((e) => e.name)).toEqual(["d"]);
    expect(diff.removed.map((e) => e.name)).toEqual(["b"]);
    expect(diff.signatureChanged.map((e) => e.name)).toEqual(["a"]);
    expect(diff.identical).toBe(false);
  });
});

describe("classifyResumeCompatibility", () => {
  it("safe for identical inventories", () => {
    const inv = capturePluginInventory([tool("x"), tool("y")]);
    expect(classifyResumeCompatibility(inv, inv).level).toBe("safe");
  });

  it("safe for added-only (superset)", () => {
    const stored = capturePluginInventory([tool("x")]);
    const current = capturePluginInventory([tool("x"), tool("y")]);
    const compat = classifyResumeCompatibility(stored, current);
    expect(compat.level).toBe("safe");
    expect(compat.diff.added.map((e) => e.name)).toEqual(["y"]);
  });

  it("unsafe when a tool is removed; reason names the removed tool", () => {
    const stored = capturePluginInventory([tool("x"), tool("y")]);
    const current = capturePluginInventory([tool("x")]);
    const compat = classifyResumeCompatibility(stored, current);
    expect(compat.level).toBe("unsafe");
    expect(compat.reason).toContain("removed: y");
  });

  it("unsafe when a tool's signature changed; reason names the tool", () => {
    const stored = capturePluginInventory([tool("x", "v1")]);
    const current = capturePluginInventory([tool("x", "v2")]);
    const compat = classifyResumeCompatibility(stored, current);
    expect(compat.level).toBe("unsafe");
    expect(compat.reason).toContain("signature changed: x");
  });

  it("includes both removed and signature changed segments in the reason", () => {
    const stored = capturePluginInventory([tool("a", "v1"), tool("b")]);
    const current = capturePluginInventory([tool("a", "v2")]);
    const compat = classifyResumeCompatibility(stored, current);
    expect(compat.level).toBe("unsafe");
    expect(compat.reason).toContain("removed: b");
    expect(compat.reason).toContain("signature changed: a");
  });
});
