import { describe, expect, it } from "vitest";
import {
  capturePluginInventory,
  fingerprintInventoryEntries,
  type PluginToolEntry,
} from "../src/plugin-inventory.js";
import type { DynamicToolSpec } from "../src/protocol.js";

function tool(overrides: Partial<DynamicToolSpec>): DynamicToolSpec {
  return {
    name: "demo",
    description: "demo tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as DynamicToolSpec;
}

describe("capturePluginInventory", () => {
  it("returns name-sorted entries", () => {
    const inventory = capturePluginInventory([
      tool({ name: "zeta" }),
      tool({ name: "alpha" }),
      tool({ name: "mid" }),
    ]);
    expect(inventory.entries.map((e) => e.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("produces a stable fingerprint regardless of input order", () => {
    const a = capturePluginInventory([
      tool({ name: "x" }),
      tool({ name: "y" }),
    ]);
    const b = capturePluginInventory([
      tool({ name: "y" }),
      tool({ name: "x" }),
    ]);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes fingerprint when description changes", () => {
    const a = capturePluginInventory([tool({ name: "x", description: "v1" })]);
    const b = capturePluginInventory([tool({ name: "x", description: "v2" })]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("changes fingerprint when inputSchema changes", () => {
    const a = capturePluginInventory([
      tool({ name: "x", inputSchema: { type: "object", properties: { a: { type: "string" } } } }),
    ]);
    const b = capturePluginInventory([
      tool({ name: "x", inputSchema: { type: "object", properties: { a: { type: "number" } } } }),
    ]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("changes fingerprint when deferLoading toggles", () => {
    const a = capturePluginInventory([tool({ name: "x", deferLoading: false })]);
    const b = capturePluginInventory([tool({ name: "x", deferLoading: true })]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("treats schema property-order as semantically identical", () => {
    const a = capturePluginInventory([
      tool({
        name: "x",
        inputSchema: {
          type: "object",
          properties: { first: { type: "string" }, second: { type: "number" } },
        },
      }),
    ]);
    const b = capturePluginInventory([
      tool({
        name: "x",
        inputSchema: {
          type: "object",
          properties: { second: { type: "number" }, first: { type: "string" } },
        },
      }),
    ]);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("fingerprintInventoryEntries", () => {
  it("sorts entries before hashing for order independence", () => {
    const a: PluginToolEntry[] = [
      { name: "z", signature: "s-z" },
      { name: "a", signature: "s-a" },
    ];
    const b: PluginToolEntry[] = [
      { name: "a", signature: "s-a" },
      { name: "z", signature: "s-z" },
    ];
    expect(fingerprintInventoryEntries(a)).toBe(fingerprintInventoryEntries(b));
  });
});
