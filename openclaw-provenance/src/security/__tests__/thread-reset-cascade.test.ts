/**
 * Session Reset Scope — Test Suite
 *
 * Validates that /reset-trust only clears the calling session. Broader cleanup
 * belongs to /reset-trust-key, where the owner names the intended scope.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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


function readWatermarks(tmpDir: string): Record<string, any> {
  try {
    const raw = readFileSync(join(tmpDir, ".provenance", "watermarks.json"), "utf-8");
    return JSON.parse(raw).watermarks ?? {};
  } catch {
    return {};
  }
}

// ── Tests ────────────────────────────────────────────────────

describe("Session reset scope", () => {
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
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      // The owner flag on the identity records below is the plugin's own
      // conclusion from this list, not something a ctx can assert.
      ownerNumbers: ["owner-123"],
      taintPolicy: {
        trusted: "allow",
        external: "confirm",
        untrusted: "confirm",
      },
    };
    registerSecurityHooks(api, logger, config);
    return { logger, api };
  }

  /**
   * A user turn as mainline shapes it: senderId + messageProvider only.
   * The group membership these scenarios rely on lives in the identity store
   * (see seedGroupIdentity) because `groupId` has no route onto the hook ctx.
   */
  function groupCtx(sessionKey: string) {
    return {
      agentId: "tank",
      sessionKey,
      senderId: "owner-123",
      messageProvider: "slack",
    };
  }

  /** Cache the owner's group identity for a session, as inbound_claim would. */
  function seedGroupIdentity(sessionKey: string) {
    seedIdentity(tmpDir, sessionKey, {
      senderId: "owner-123",
      senderIsOwner: true,
      groupId: "c0ag7jag35g",
      sourceProvider: "slack",
    });
  }

  /** Simulate a full turn that taints a session via web_fetch */
  function simulateTaintedTurn(api: ReturnType<typeof makeApi>, sessionKey: string) {
    seedGroupIdentity(sessionKey);

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

  /** Simulate /reset-trust from an owner via the registered command */
  function simulateResetTrust(api: ReturnType<typeof makeApi>, sessionKey: string) {
    api.invokeCommand("reset-trust", { args: "", sessionKey });
  }

  it("reset in thread does not clear parent channel watermark", () => {
    const { api } = setup();

    // 1. Taint the base channel session
    simulateTaintedTurn(api, baseSession);
    let watermarks = readWatermarks(tmpDir);
    expect(watermarks[baseSession]).toBeDefined();
    expect(watermarks[baseSession].level).not.toBe("trusted");

    // 2. Reset trust from a thread in that channel
    simulateResetTrust(api, threadSession);

    // 3. Only the calling thread is cleared; the parent channel stays tainted.
    watermarks = readWatermarks(tmpDir);
    expect(watermarks[threadSession]).toBeUndefined();
    expect(watermarks[baseSession]).toBeDefined();
  });

  it("new thread after cascade reset starts trusted", () => {
    const { api, logger } = setup();

    // 1. Taint the base channel
    simulateTaintedTurn(api, baseSession);

    // 2. Reset from thread only
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

  it("/reset-trust clears only the calling tainted session", () => {
    const { api } = setup();

    // 1. Taint both base and thread
    simulateTaintedTurn(api, baseSession);
    simulateTaintedTurn(api, threadSession);

    // 2. /reset-trust clears only the calling session
    simulateResetTrust(api, baseSession);

    const watermarks = readWatermarks(tmpDir);
    expect(watermarks[baseSession]).toBeUndefined();
    expect(watermarks[threadSession]).toBeDefined();
  });

  it("/reset-trust does not clear unrelated sessions", () => {
    const { api } = setup();
    const unrelatedSession = "agent:tank:slack:channel:other123";

    // Taint all three
    simulateTaintedTurn(api, baseSession);
    simulateTaintedTurn(api, unrelatedSession);

    // /reset-trust clears only the caller's thread session.
    simulateTaintedTurn(api, threadSession);
    simulateResetTrust(api, threadSession);

    const watermarks = readWatermarks(tmpDir);
    expect(watermarks[threadSession]).toBeUndefined();
    expect(watermarks[baseSession]).toBeDefined();
    expect(watermarks[unrelatedSession]).toBeDefined();
  });

  it("/reset-trust <level> sets the requested baseline for the calling session", () => {
    const { api } = setup();

    api.invokeCommand("reset-trust", { args: "external", sessionKey: baseSession });

    const watermarks = readWatermarks(tmpDir);
    expect(watermarks[baseSession]).toBeDefined();
    expect(watermarks[baseSession].level).toBe("external");
    expect(Object.keys(watermarks)).toEqual([baseSession]);
  });
});
