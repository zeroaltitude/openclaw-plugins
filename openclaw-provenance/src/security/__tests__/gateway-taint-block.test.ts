/**
 * Gateway Tool Blocking at Untrusted Taint Level — Regression Test
 *
 * Validates that the gateway tool (config.patch, restart, etc.) is blocked
 * when session taint escalates due to web_fetch from an untrusted URL.
 *
 * Bug: web_fetch to an untrusted URL should escalate taint to "external",
 * persisting via watermark. In the next turn, gateway should be blocked
 * (toolOverrides: gateway.external = "confirm"), but it was allowed through.
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

// ── Config matching Eddie's actual openclaw.json ──────────────

const CONFIG: SecurityPluginConfig = {
  taintPolicy: {
    trusted: "allow",
    shared: "confirm",
    external: "confirm",
    untrusted: "confirm",
  },
  toolOverrides: {
    gateway: {
      trusted: "allow",
      shared: "confirm",
      external: "confirm",
      untrusted: "confirm",
    },
  },
  toolOutputTaints: {
    web_fetch: "external",
    web_search: "external",
    exec: "trusted",
    message: "trusted",
    vestige_search: "trusted",
    memory_search: "trusted",
    memory_get: "trusted",
  },
  // No URI trust for vestige.bighatbio.me — that's the scenario
  uriTrust: {},
  trustedSenderIds: ["owner-123"],
  developerMode: false,
};

const SESSION_KEY = "agent:main:main";

const OWNER_CTX = {
  sessionKey: SESSION_KEY,
  senderId: "owner-123",
  senderIsOwner: true,
  senderName: "owner",
};

// ── Tests ────────────────────────────────────────────────────

describe("Gateway blocked after untrusted web_fetch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-gateway-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should block gateway in next turn after web_fetch to untrusted URL", () => {
    const logger = makeLogger();
    const api = makeApi();

    registerSecurityHooks(api as any, logger as any, {
      ...CONFIG,
      workspaceDir: tmpDir,
    });

    // ── Turn 1: web_fetch to untrusted URL ──

    // 1a. context_assembled — turn starts trusted
    api.fire("context_assembled", {
      systemPrompt: "You are a helpful assistant.",
      messageCount: 1,
      messages: [{ role: "user", content: "Check if vestige is healthy" }],
    }, OWNER_CTX);

    // 1b. before_llm_call — LLM prepares response with tool calls
    api.fire("before_llm_call", {
      tools: [
        { function: { name: "web_fetch" } },
        { function: { name: "gateway" } },
        { function: { name: "exec" } },
      ],
    }, OWNER_CTX);

    // 1c. after_llm_call — LLM chose to call web_fetch with untrusted URL
    api.fire("after_llm_call", {
      toolCalls: [{
        name: "web_fetch",
        params: { url: "https://vestige.bighatbio.me/api/health" },
      }],
      iteration: 0,
    }, OWNER_CTX);

    // 1d. before_tool_call — web_fetch executes (should be allowed or confirm)
    const webFetchResult = api.fire("before_tool_call", {
      toolName: "web_fetch",
      params: { url: "https://vestige.bighatbio.me/api/health" },
    }, OWNER_CTX);

    // 1e. after_tool_call — tool completed
    api.fire("after_tool_call", {
      toolName: "web_fetch",
      params: { url: "https://vestige.bighatbio.me/api/health" },
      result: '{"status":"unhealthy"}',
    }, OWNER_CTX);

    // 1f. before_response_emit — turn completes, watermark should be set
    api.fire("before_response_emit", {
      content: "Vestige health check returned unhealthy status.",
    }, OWNER_CTX);

    // ── Turn 2: gateway config.patch ──

    // 2a. context_assembled — should inherit taint from Turn 1's watermark
    api.fire("context_assembled", {
      systemPrompt: "You are a helpful assistant.",
      messageCount: 3,
      messages: [
        { role: "user", content: "Check if vestige is healthy" },
        { role: "assistant", content: "Vestige health check returned unhealthy status." },
        { role: "user", content: "Please trust vestige.bighatbio.me" },
      ],
    }, OWNER_CTX);

    // 2b. before_llm_call — check what tools are available
    const llmResult = api.fire("before_llm_call", {
      tools: [
        { function: { name: "web_fetch" } },
        { function: { name: "gateway" } },
        { function: { name: "exec" } },
        { function: { name: "read" } },
      ],
    }, OWNER_CTX);

    // At this point, gateway should be restricted (taint = external)
    // Check if gateway was removed from tools list
    const removedTools = llmResult?.tools
      ? llmResult.tools.map((t: any) => t.function?.name)
      : undefined;

    // 2c. after_llm_call — LLM chose gateway (shouldn't have been allowed)
    api.fire("after_llm_call", {
      toolCalls: [{
        name: "gateway",
        params: { action: "config.patch" },
      }],
      iteration: 0,
    }, OWNER_CTX);

    // 2d. before_tool_call — THIS IS THE KEY CHECK
    // Gateway should be BLOCKED because session taint is external/untrusted
    const gatewayResult = api.fire("before_tool_call", {
      toolName: "gateway",
      params: { action: "config.patch" },
    }, OWNER_CTX);

    // ASSERTION: gateway should be blocked (block: true)
    expect(gatewayResult?.block).toBe(true);

    // Check the block reason mentions taint level
    if (gatewayResult?.blockReason) {
      expect(gatewayResult.blockReason).toMatch(/taint|approval|restricted/i);
    }

    // Also verify: exec should also be blocked in turn 2
    const execResult = api.fire("before_tool_call", {
      toolName: "exec",
      params: { command: "echo hello" },
    }, OWNER_CTX);

    expect(execResult?.block).toBe(true);
  });

  it("should allow gateway after .reset-trust clears the taint", () => {
    const logger = makeLogger();
    const api = makeApi();

    registerSecurityHooks(api as any, logger as any, {
      ...CONFIG,
      workspaceDir: tmpDir,
    });

    // ── Turn 1: web_fetch taints session ──
    api.fire("context_assembled", {
      systemPrompt: "test",
      messageCount: 1,
      messages: [{ role: "user", content: "check vestige" }],
    }, OWNER_CTX);

    api.fire("before_llm_call", {
      tools: [{ function: { name: "web_fetch" } }],
    }, OWNER_CTX);

    api.fire("after_llm_call", {
      toolCalls: [{
        name: "web_fetch",
        params: { url: "https://vestige.bighatbio.me/api/health" },
      }],
      iteration: 0,
    }, OWNER_CTX);

    api.fire("before_tool_call", {
      toolName: "web_fetch",
      params: { url: "https://vestige.bighatbio.me/api/health" },
    }, OWNER_CTX);

    api.fire("after_tool_call", {
      toolName: "web_fetch",
      params: { url: "https://vestige.bighatbio.me/api/health" },
      result: "error",
    }, OWNER_CTX);

    api.fire("before_response_emit", {
      content: "Vestige is down.",
    }, OWNER_CTX);

    // ── Turn 2: owner sends .reset-trust ──
    api.fire("context_assembled", {
      systemPrompt: "test",
      messageCount: 3,
      messages: [
        { role: "user", content: "check vestige" },
        { role: "assistant", content: "Vestige is down." },
        { role: "user", content: ".reset-trust" },
      ],
    }, OWNER_CTX);

    api.fire("before_llm_call", {
      tools: [{ function: { name: "gateway" } }],
    }, OWNER_CTX);

    api.fire("after_llm_call", {
      toolCalls: [{
        name: "gateway",
        params: { action: "config.patch" },
      }],
      iteration: 0,
    }, OWNER_CTX);

    // After .reset-trust, gateway should be allowed
    const gatewayResult = api.fire("before_tool_call", {
      toolName: "gateway",
      params: { action: "config.patch" },
    }, OWNER_CTX);

    expect(gatewayResult?.block).not.toBe(true);
  });
});
