/**
 * Plugin startup warning — Test Suite
 *
 * Verifies that the provenance plugin warns when internal hooks
 * are not enabled (required for session save policy enforcement).
 */

import { describe, it, expect, vi } from "vitest";
import { register } from "../index.js";

function makeApi(configOverrides: Record<string, unknown> = {}) {
  const logs: { level: string; msg: string }[] = [];
  return {
    api: {
      registerTool: vi.fn(),
      on: vi.fn(),
      pluginConfig: {},
      config: { ...configOverrides },
      logger: {
        info: (...args: any[]) => logs.push({ level: "info", msg: args.join(" ") }),
        warn: (...args: any[]) => logs.push({ level: "warn", msg: args.join(" ") }),
        error: (...args: any[]) => logs.push({ level: "error", msg: args.join(" ") }),
        debug: (...args: any[]) => logs.push({ level: "debug", msg: args.join(" ") }),
      },
    },
    logs,
  };
}

describe("startup warning", () => {
  it("warns when hooks.internal.enabled is missing", () => {
    const { api, logs } = makeApi({});
    register(api as any);
    const warning = logs.find(
      (l) => l.level === "warn" && l.msg.includes("hooks.internal.enabled"),
    );
    expect(warning).toBeDefined();
  });

  it("warns when hooks.internal.enabled is false", () => {
    const { api, logs } = makeApi({ hooks: { internal: { enabled: false } } });
    register(api as any);
    const warning = logs.find(
      (l) => l.level === "warn" && l.msg.includes("hooks.internal.enabled"),
    );
    expect(warning).toBeDefined();
  });

  it("does not warn when hooks.internal.enabled is true", () => {
    const { api, logs } = makeApi({ hooks: { internal: { enabled: true } } });
    register(api as any);
    const warning = logs.find(
      (l) => l.level === "warn" && l.msg.includes("hooks.internal.enabled"),
    );
    expect(warning).toBeUndefined();
  });
});
