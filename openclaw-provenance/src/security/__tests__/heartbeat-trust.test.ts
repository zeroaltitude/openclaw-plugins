/**
 * Heartbeat Trust Classification — Test Suite
 *
 * Validates that heartbeat turns are classified as trusted even though
 * `messageProvider` reflects the delivery channel (e.g. "discord") rather
 * than the source, using only signals production actually delivers:
 *
 *   1. the sessionKey system-source segment (`…:heartbeat`) — the real
 *      defense, since mainline strips identity for every non-user trigger and
 *      never puts a `sourceProvider` on the agent hook ctx;
 *   2. the `missingIdentityTrust` config — the fallback for a turn with no
 *      identity record at all.
 *
 * The `identity.sourceProvider` branch of classifyInitialTrust (written by
 * `inbound_claim`, not by the hook ctx) is pinned in
 * `initial-trust-classification.test.ts`.
 *
 * Ownership is never declared on a ctx here: `senderIsOwner` is the plugin's
 * own conclusion from configured `ownerNumbers`, so tests that need an owner
 * configure one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSecurityHooks,
  type SecurityPluginConfig,
} from "../index.js";
import { makeApi } from "./test-shim.js";

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

  it("classifies a heartbeat sessionKey segment as trusted", () => {
    // Regression: when core dispatches a heartbeat turn it populates no
    // identity at all (`buildAgentHookContextIdentityFields()` returns `{}`
    // for every trigger !== "user"), so the sessionKey segment is the only
    // signal that the turn isn't user-driven. Without this fallback, an
    // interrupted heartbeat turn silently escalates the watermark to
    // non-trusted (the …ddpw95:heartbeat sealing bug).
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

  it("falls to missingIdentityTrust (shared) without an identity or a heartbeat segment", () => {
    // Negative control for the test above: same identity-less ctx, but on an
    // ordinary channel session key. This is the pre-fallback bug shape — a
    // heartbeat delivered over discord whose session key carried no marker.
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

  it("classifies an identity-less turn as trusted when missingIdentityTrust is configured", () => {
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
    });

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: external");
  });

  it("classifies owner discord messages as trusted via ownerNumbers", () => {
    // Was previously configured with `trustedSenderIds: ["owner-123"]` AND a
    // `senderIsOwner: true` ctx field, so it passed on either path and
    // distinguished neither. No trustedSenderIds here: the only route to
    // trusted is ownerNumbers → computeSenderIsOwner → the owner branch.
    const { api, logger } = setup({
      ownerNumbers: ["owner-123"],
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
    });

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
    expect(trustLine).toContain("owner=true");
  });

  it("classifies a trustedSenderIds sender as trusted without making them an owner", () => {
    // The other half of the split: trust by allowlisted sender id, with no
    // ownerNumbers entry. `owner=false` is the assertion that separates this
    // path from the one above — an allowlisted sender gets trusted content
    // classification, not owner privileges (e.g. the owner-DM exception).
    const { api, logger } = setup({
      trustedSenderIds: ["helper-456"],
    });

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "hello" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:123",
      messageProvider: "discord",
      senderId: "helper-456",
    });

    const trustLine = logger.logs.find(l => l.includes("CLASSIFY_INITIAL_TRUST:"));
    expect(trustLine).toBeDefined();
    expect(trustLine).toContain("CLASSIFY_INITIAL_TRUST: trusted");
    expect(trustLine).toContain("owner=false");
  });

  it("allows heartbeat_respond and keeps its output trusted during heartbeat turns", () => {
    const cleanSessionKey = "agent:main:slack:channel:clean:heartbeat";
    const taintedSessionKey = "agent:main:slack:channel:tainted:heartbeat";
    const { api, store } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "heartbeat" }],
      messageCount: 1,
    }, {
      agentId: "main",
      sessionKey: cleanSessionKey,
      messageProvider: "slack",
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
