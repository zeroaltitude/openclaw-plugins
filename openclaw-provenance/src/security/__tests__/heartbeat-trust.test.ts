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
import { makeApi, seedIdentity } from "./test-shim.js";

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
    const api = makeApi(tmpDir);
    const { store } = registerSecurityHooks(api, logger, {
      workspaceDir: tmpDir,
      verbose: true,
      ...config,
    });
    return { api, logger, store };
  }

  it("classifies heartbeat with sourceProvider as trusted", () => {
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

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
    expect(trustLine).toContain("sourceProvider=heartbeat");
  });

  it("classifies heartbeat WITHOUT sourceProvider as shared (default missingIdentityTrust)", () => {
    const { api, logger } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
    });

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: shared");
  });

  it("classifies heartbeat sessionKey suffix as trusted even when sourceProvider is missing", () => {
    // Regression: when core dispatches a heartbeat turn without populating
    // identity.sourceProvider, the sessionKey suffix is the only signal that
    // the turn isn't user-driven. Without this fallback, an interrupted
    // heartbeat turn silently escalates the watermark to non-trusted (the
    // …ddpw95:heartbeat sealing bug).
    const { api, logger } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "tabitha",
      sessionKey: "agent:tabitha:discord:channel:ddpw95:heartbeat",
      messageProvider: "discord",
    });

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
  });

  it("classifies heartbeat WITHOUT sourceProvider as trusted when missingIdentityTrust is configured", () => {
    const { api, logger } = setup({
      missingIdentityTrust: "trusted",
    });

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
    });

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
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

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
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

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
  });

  it("still classifies external discord messages as external/shared", () => {
    const { api, logger } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "hello" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      senderId: "unknown-user-456",
      senderIsOwner: false,
    });

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: external");
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

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
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

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("provider=discord");
    expect(trustLine).toContain("sourceProvider=heartbeat");
    expect(trustLine).toContain("effectiveProvider=heartbeat");
  });

  it("allows heartbeat_respond and keeps its output trusted during heartbeat turns", () => {
    const cleanSessionKey = "agent:main:slack:channel:heartbeat-clean";
    const taintedSessionKey = "agent:main:slack:channel:heartbeat-tainted";
    const { api, store } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: cleanSessionKey,
      messageProvider: "slack",
      sourceProvider: "heartbeat",
    });

    api.fire("after_tool_call", {
      toolName: "heartbeat_respond",
      params: { outcome: "progress", notify: true },
      result: { status: "recorded", outcome: "progress", notify: true },
    }, {
      agentId: "main",
      sessionKey: cleanSessionKey,
    });

    expect(store.getActive(cleanSessionKey)?.maxTaint).toBe("trusted");

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: taintedSessionKey,
      messageProvider: "slack",
      sourceProvider: "heartbeat",
    });
    store.getActive(taintedSessionKey)?.recordToolCall("web_fetch", 1);

    const result = api.fire("before_tool_call", {
      toolName: "heartbeat_respond",
      params: { outcome: "progress", notify: true },
    }, {
      agentId: "main",
      sessionKey: taintedSessionKey,
    });

    expect(result).toBeUndefined();
  });
});
