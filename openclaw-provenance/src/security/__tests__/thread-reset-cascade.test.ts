/**
 * Thread Reset Cascade — Test Suite
 *
 * Validates that .reset-trust in a thread session also clears the
 * parent channel session's watermark, preventing stale taint from
 * re-infecting new threads.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

function readWatermarks(tmpDir: string): Record<string, any> {
  try {
    const raw = readFileSync(join(tmpDir, ".provenance", "watermarks.json"), "utf-8");
    return JSON.parse(raw).watermarks ?? {};
  } catch {
    return {};
  }
}

// ── Tests ────────────────────────────────────────────────────

describe("Thread reset cascade", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-thread-reset-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseSession = "agent:tank:slack:channel:c0ag7jag35g";
  const threadSession = "agent:tank:slack:channel:c0ag7jag35g:thread:1234567890";
  const newThreadSession = "agent:tank:slack:channel:c0ag7jag35g:thread:9999999999";

  function setup() {
    const logger = makeLogger();
    const api = makeApi();
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "confirm",
        untrusted: "confirm",
      },
    };
    registerSecurityHooks(api, logger, config);
    return { logger, api };
  }

  function groupCtx(sessionKey: string) {
    return {
      agentId: "tank",
      sessionKey,
      senderIsOwner: true,
      senderId: "owner-123",
      groupId: "c0ag7jag35g",
    };
  }

  /** Simulate a full turn that taints a session via web_fetch */
  function simulateTaintedTurn(api: ReturnType<typeof makeApi>, sessionKey: string) {
    // 1. context_assembled — start the session/graph
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, groupCtx(sessionKey));

    // 2. after_llm_call — log proposed tool calls (no taint escalation)
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_fetch", params: { url: "https://evil.com/payload" } }],
    }, groupCtx(sessionKey));

    // 3. after_tool_call — taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "web_fetch",
      params: { url: "https://evil.com/payload" },
      result: { content: [{ type: "text", text: "payload content" }] },
    }, groupCtx(sessionKey));

    // 4. before_response_emit — flushes watermark to disk
    api.fire("before_response_emit", {}, groupCtx(sessionKey));
  }

  /** Simulate .reset-trust from an owner */
  function simulateResetTrust(api: ReturnType<typeof makeApi>, sessionKey: string) {
    api.fire("context_assembled", {
      systemPrompt: "",
      messageCount: 1,
      messages: [{ role: "user", content: [{ type: "text", text: ".reset-trust" }] }],
    }, { ...groupCtx(sessionKey), senderIsOwner: true });
  }

  it("reset in thread clears parent channel watermark", () => {
    const { api } = setup();

    // 1. Taint the base channel session
    simulateTaintedTurn(api, baseSession);
    let watermarks = readWatermarks(tmpDir);
    expect(watermarks[baseSession]).toBeDefined();
    expect(watermarks[baseSession].level).not.toBe("trusted");

    // 2. Reset trust from a thread in that channel
    simulateResetTrust(api, threadSession);

    // 3. Both the thread AND parent watermarks should be cleared
    watermarks = readWatermarks(tmpDir);
    expect(watermarks[threadSession]).toBeUndefined();
    expect(watermarks[baseSession]).toBeUndefined();
  });

  it("new thread after cascade reset starts trusted", () => {
    const { api, logger } = setup();

    // 1. Taint the base channel
    simulateTaintedTurn(api, baseSession);

    // 2. Reset from thread (cascades to parent)
    simulateResetTrust(api, threadSession);

    // 3. New thread should start clean — no inherited taint
    api.fire("context_assembled", {
      systemPrompt: "",
      messageCount: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }, groupCtx(newThreadSession));

    // No taint inheritance log for the new thread
    const inheritLog = logger.logs.find(l =>
      l.includes("inherited-taint") && l.includes(newThreadSession.slice(-8)),
    );
    // The watermark should not exist for the new thread
    const watermarks = readWatermarks(tmpDir);
    expect(watermarks[newThreadSession]).toBeUndefined();
  });

  it("reset in base channel does NOT cascade to threads", () => {
    const { api } = setup();

    // 1. Taint both base and thread
    simulateTaintedTurn(api, baseSession);
    simulateTaintedTurn(api, threadSession);

    // 2. Reset from base channel only (not a thread, no cascade)
    simulateResetTrust(api, baseSession);

    // 3. Base should be cleared, thread should still be tainted
    const watermarks = readWatermarks(tmpDir);
    expect(watermarks[baseSession]).toBeUndefined();
    expect(watermarks[threadSession]).toBeDefined();
  });

  it("reset in thread does not affect unrelated sessions", () => {
    const { api } = setup();
    const unrelatedSession = "agent:tank:slack:channel:other123";

    // Taint both
    simulateTaintedTurn(api, baseSession);
    simulateTaintedTurn(api, unrelatedSession);

    // Reset from thread (should cascade to parent only)
    simulateResetTrust(api, threadSession);

    // Unrelated session should still be tainted
    const watermarks = readWatermarks(tmpDir);
    expect(watermarks[baseSession]).toBeUndefined();
    expect(watermarks[unrelatedSession]).toBeDefined();
  });
});
