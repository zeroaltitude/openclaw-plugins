/**
 * Heartbeat Trust Classification — Test Suite
 *
 * Validates that heartbeats are classified as trusted even when
 * messageProvider reflects the delivery channel (e.g. "discord")
 * rather than the source ("heartbeat").
 *
 * Tests three defense layers:
 *   1. sourceProvider — overrides messageProvider for trust classification
 *   2. missingIdentityTrust config — fallback for unknown senders
 *   3. Both together — belt and suspenders
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSecurityHooks,
  type SecurityPluginConfig,
} from "../index.js";

// ── Helpers ──────────────────────────────────────────────────

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push("WARN: " + args.join(" ")),
    error: (...args: any[]) => logs.push("ERROR: " + args.join(" ")),
    logs,
  };
}

interface HookHandler {
  (...args: any[]): any;
}

function makeApi() {
  const hooks = new Map<string, HookHandler[]>();
  return {
    on(name: string, handler: HookHandler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name)!.push(handler);
    },
    fire(name: string, event: any, ctx: any): any {
      const handlers = hooks.get(name) ?? [];
      let result: any;
      for (const h of handlers) {
        result = h(event, ctx);
      }
      return result;
    },
    hooks,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("Heartbeat trust classification", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-heartbeat-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(config?: Partial<SecurityPluginConfig>) {
    const logger = makeLogger();
    const api = makeApi();
    const { store } = registerSecurityHooks(api, logger, {
      workspaceDir: tmpDir,
      verbose: true,
      ...config,
    });
    return { api, logger, store };
  }

  it("classifies heartbeat with sourceProvider as trusted", () => {
    const { api, logger } = setup();

    // Simulate a heartbeat delivered via discord:
    // messageProvider="discord" but sourceProvider="heartbeat"
    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      sourceProvider: "heartbeat",
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("Initial trust: trusted");
    expect(trustLine).toContain("source: heartbeat");
  });

  it("classifies heartbeat WITHOUT sourceProvider as shared (default missingIdentityTrust)", () => {
    const { api, logger } = setup();

    // Old behavior: no sourceProvider, no senderId, messageProvider="discord"
    // Falls through to missingIdentityTrust default of "shared"
    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      // no sourceProvider, no senderId, no senderIsOwner
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toBeDefined();
    // Without sourceProvider or missingIdentityTrust config, defaults to "shared"
    expect(trustLine).toContain("Initial trust: shared");
  });

  it("classifies heartbeat WITHOUT sourceProvider as trusted when missingIdentityTrust is configured", () => {
    const { api, logger } = setup({
      missingIdentityTrust: "trusted",
    });

    // Bug 2 fix: missingIdentityTrust="trusted" prevents escalation
    // even when sourceProvider is not available
    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      // no sourceProvider, no senderId, no senderIsOwner
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("Initial trust: trusted");
  });

  it("classifies cron-event sourceProvider as trusted", () => {
    const { api, logger } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "cron task" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      sourceProvider: "cron-event",
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toContain("Initial trust: trusted");
  });

  it("classifies exec-event sourceProvider as trusted", () => {
    const { api, logger } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "exec done" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      sourceProvider: "exec-event",
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toContain("Initial trust: trusted");
  });

  it("still classifies external discord messages as external/shared", () => {
    const { api, logger } = setup();

    // Real discord message from unknown non-owner sender
    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "hello" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      // no sourceProvider — this is a real discord message
      senderId: "unknown-user-456",
      senderIsOwner: false,
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("Initial trust: external");
  });

  it("classifies owner discord messages as trusted", () => {
    const { api, logger } = setup({
      trustedSenderIds: ["owner-123"],
    });

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "hello" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      senderId: "owner-123",
      senderIsOwner: true,
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toContain("Initial trust: trusted");
  });

  it("logs sourceProvider when it differs from messageProvider", () => {
    const { api, logger } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      sourceProvider: "heartbeat",
    });

    const trustLine = logger.logs.find(l => l.includes("Initial trust:"));
    expect(trustLine).toContain("provider: discord");
    expect(trustLine).toContain("source: heartbeat");
  });
});
