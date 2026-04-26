/**
 * Browser Snapshot Taint — Test Suite
 *
 * Validates that browser content tools (snapshot, screenshot, etc.) have
 * taint evaluated in after_tool_call (post-execution) using observed output.
 * after_llm_call no longer escalates taint — it only logs and gates.
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

const ownerCtx = {
  agentId: "main",
  sessionKey: "agent:main:discord:dm:owner",
  messageProvider: "discord",
  senderId: "owner-123",
  senderIsOwner: true,
};

// ── Tests ────────────────────────────────────────────────────

describe("Browser snapshot taint deferral", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-browser-test-"));
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

  /** Run context_assembled + before_llm_call + after_llm_call for a browser tool call.
   *  after_llm_call no longer escalates taint — call after_tool_call to evaluate. */
  function simulateBrowserToolCall(
    api: ReturnType<typeof makeApi>,
    ctx: typeof ownerCtx,
    toolAction: string,
    toolParams: Record<string, unknown>,
  ) {
    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "take a snapshot" }],
      messageCount: 1,
    }, ctx);

    api.fire("before_llm_call", {
      iteration: 1,
      messages: [{ role: "user", content: "take a snapshot" }],
      messageCount: 1,
      tools: [{ name: "browser" }],
    }, ctx);

    api.fire("after_llm_call", {
      iteration: 1,
      toolCalls: [{
        name: "browser",
        arguments: { action: toolAction, ...toolParams },
      }],
    }, ctx);
  }

  /** Fire after_tool_call to evaluate taint for a tool that has executed */
  function simulateToolComplete(
    api: ReturnType<typeof makeApi>,
    ctx: typeof ownerCtx,
    toolName: string,
    params: Record<string, unknown>,
    result?: unknown,
  ) {
    api.fire("after_tool_call", {
      toolName,
      params,
      result: result ?? { content: [{ type: "text", text: "ok" }] },
    }, ctx);
  }

  it("browser.snapshot without targetId defers taint (stays trusted)", () => {
    const { api, logger, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {});

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph).toBeDefined();
    expect(graph!.maxTaint).toBe("trusted");

    // Should NOT log a taint escalation
    const escalationLine = logger.logs.find(l => l.includes("TOOL_TAINT_ESCALATION"));
    expect(escalationLine).toBeUndefined();
  });

  it("browser.screenshot without targetId defers taint (stays trusted)", () => {
    const { api, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "screenshot", {});

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("trusted");
  });

  it("browser.snapshot with unresolvable targetId defers taint (stays trusted)", () => {
    const { api, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {
      targetId: "unknown-tab-id-123",
    });

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("trusted");
  });

  it("after_tool_call with trusted URL does not escalate", () => {
    const { api, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {
      targetId: "tab-abc",
    });

    // Simulate tool result with a trusted URL (openclaw.ai)
    api.fire("after_tool_call", {
      toolName: "browser",
      params: { action: "snapshot", targetId: "tab-abc" },
      result: {
        // Mainline's enrichTabResponseBody puts {targetId,url} at the
        // top level of the response body, which is serialised into
        // content[].text. Legacy result.details fallback is gone.
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            targetId: "tab-abc",
            url: "https://openclaw.ai/dashboard",
          }),
        }],
      },
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("trusted");
  });

  it("after_tool_call with untrusted URL escalates taint", () => {
    const { api, logger, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {
      targetId: "tab-xyz",
    });

    // Taint should still be trusted (after_llm_call no longer escalates)
    expect(store.getActive(ownerCtx.sessionKey)!.maxTaint).toBe("trusted");

    // Simulate tool result with an untrusted URL
    api.fire("after_tool_call", {
      toolName: "browser",
      params: { action: "snapshot", targetId: "tab-xyz" },
      result: {
        // Enriched shape (post-mainline enrichTabResponseBody).
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            targetId: "tab-xyz",
            url: "https://evil-site.example.com/malware",
          }),
        }],
      },
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("untrusted");

    const escalationLine = logger.logs.find(l => l.includes("TOOL_TAINT_ESCALATION"));
    expect(escalationLine).toBeDefined();
  });

  it("after_tool_call applies default tool taint when URL is missing from result", () => {
    const { api, logger, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {});

    // Taint stays trusted (after_llm_call no longer escalates)
    expect(store.getActive(ownerCtx.sessionKey)!.maxTaint).toBe("trusted");

    // Simulate tool result WITHOUT details.url
    api.fire("after_tool_call", {
      toolName: "browser",
      params: { action: "snapshot" },
      result: {
        content: [{ type: "text", text: "page content" }],
        // No details.url — universal taint evaluation uses default tool taint
      },
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    // Universal evaluation applies browser.snapshot's default output taint ("external")
    expect(graph!.maxTaint).toBe("external");

    const escalationLine = logger.logs.find(l => l.includes("TOOL_TAINT_ESCALATION"));
    expect(escalationLine).toBeDefined();
  });

  it("browser.tabs does NOT defer (remains trusted)", () => {
    const { api, store } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "list tabs" }],
      messageCount: 1,
    }, ownerCtx);

    api.fire("before_llm_call", {
      iteration: 1,
      messages: [{ role: "user", content: "list tabs" }],
      messageCount: 1,
      tools: [{ name: "browser" }],
    }, ownerCtx);

    api.fire("after_llm_call", {
      iteration: 1,
      toolCalls: [{
        name: "browser",
        arguments: { action: "tabs" },
      }],
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    // browser.tabs has default output taint "trusted"
    expect(graph!.maxTaint).toBe("trusted");
  });

  it("browser.open is NOT deferred (control action with trusted output taint)", () => {
    const { api, store } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "open browser" }],
      messageCount: 1,
    }, ownerCtx);

    api.fire("before_llm_call", {
      iteration: 1,
      messages: [{ role: "user", content: "open browser" }],
      messageCount: 1,
      tools: [{ name: "browser" }],
    }, ownerCtx);

    // browser.open without a URL — output taint is "trusted" so no escalation
    api.fire("after_llm_call", {
      iteration: 1,
      toolCalls: [{
        name: "browser",
        arguments: { action: "open" },
      }],
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    // browser.open has default output taint "trusted"
    expect(graph!.maxTaint).toBe("trusted");
  });

  // ── URL extraction from content text (MCP standard format) ──

  it("after_tool_call extracts URL from content text JSON and escalates for untrusted site", () => {
    const { api, logger, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {});

    expect(store.getActive(ownerCtx.sessionKey)!.maxTaint).toBe("trusted");

    // MCP browser tools return URL in content[0].text JSON, not in result.details
    api.fire("after_tool_call", {
      toolName: "browser",
      params: { action: "snapshot" },
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            targetId: "tab-123",
            url: "https://evil-site.example.com/phishing",
            snapshot: "page content here",
          }),
        }],
      },
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("untrusted");

    const escalationLine = logger.logs.find(l => l.includes("TOOL_TAINT_ESCALATION"));
    expect(escalationLine).toBeDefined();
  });

  it("after_tool_call extracts URL from content text JSON and stays trusted for openclaw.ai", () => {
    const { api, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {});

    api.fire("after_tool_call", {
      toolName: "browser",
      params: { action: "snapshot" },
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            targetId: "tab-456",
            url: "https://openclaw.ai/dashboard",
            snapshot: "page content here",
          }),
        }],
      },
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("trusted");
  });

  it("after_tool_call handles bare 'browser' toolName when params.action is missing", () => {
    const { api, logger, store } = setup();

    simulateBrowserToolCall(api, ownerCtx, "snapshot", {});

    expect(store.getActive(ownerCtx.sessionKey)!.maxTaint).toBe("trusted");

    // Core may not pass params.action to after_tool_call — composite key
    // resolution fails, toolKey = "browser" (bare name)
    api.fire("after_tool_call", {
      toolName: "browser",
      params: {}, // no action!
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            url: "https://hackers.com/recruit",
            snapshot: "hacker content",
          }),
        }],
      },
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("untrusted");

    const escalationLine = logger.logs.find(l => l.includes("TOOL_TAINT_ESCALATION"));
    expect(escalationLine).toBeDefined();
  });

  // ── URI pattern matching: /** matches bare domain (no trailing path) ──

  it("browser.navigate to https://openclaw.ai (no path) stays trusted", () => {
    const { api, store } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "navigate to openclaw" }],
      messageCount: 1,
    }, ownerCtx);

    api.fire("before_llm_call", {
      iteration: 1,
      messages: [{ role: "user", content: "navigate to openclaw" }],
      messageCount: 1,
      tools: [{ name: "browser" }],
    }, ownerCtx);

    api.fire("after_llm_call", {
      iteration: 1,
      toolCalls: [{
        name: "browser",
        arguments: { action: "navigate", targetUrl: "https://openclaw.ai" },
      }],
    }, ownerCtx);

    // Taint evaluated in after_tool_call — navigate with trusted URL
    simulateToolComplete(api, ownerCtx, "browser", { action: "navigate", targetUrl: "https://openclaw.ai" });

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("trusted");
  });

  it("browser.navigate to https://openclaw.ai/dashboard stays trusted", () => {
    const { api, store } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "navigate" }],
      messageCount: 1,
    }, ownerCtx);

    api.fire("before_llm_call", {
      iteration: 1,
      messages: [{ role: "user", content: "navigate" }],
      messageCount: 1,
      tools: [{ name: "browser" }],
    }, ownerCtx);

    api.fire("after_llm_call", {
      iteration: 1,
      toolCalls: [{
        name: "browser",
        arguments: { action: "navigate", targetUrl: "https://openclaw.ai/dashboard" },
      }],
    }, ownerCtx);

    // Taint evaluated in after_tool_call
    simulateToolComplete(api, ownerCtx, "browser", { action: "navigate", targetUrl: "https://openclaw.ai/dashboard" });

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("trusted");
  });

  it("browser.navigate to untrusted site escalates taint", () => {
    const { api, store } = setup();

    api.fire("context_assembled", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "navigate" }],
      messageCount: 1,
    }, ownerCtx);

    api.fire("before_llm_call", {
      iteration: 1,
      messages: [{ role: "user", content: "navigate" }],
      messageCount: 1,
      tools: [{ name: "browser" }],
    }, ownerCtx);

    api.fire("after_llm_call", {
      iteration: 1,
      toolCalls: [{
        name: "browser",
        arguments: { action: "navigate", targetUrl: "https://hackers.com" },
      }],
    }, ownerCtx);

    // Taint evaluated in after_tool_call
    simulateToolComplete(api, ownerCtx, "browser", { action: "navigate", targetUrl: "https://hackers.com" });

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("untrusted");
  });

  it("two snapshots: trusted site then untrusted site escalates correctly", () => {
    const { api, store } = setup();

    // Turn 1: snapshot openclaw.ai — stays trusted
    simulateBrowserToolCall(api, ownerCtx, "snapshot", {});

    api.fire("after_tool_call", {
      toolName: "browser",
      params: { action: "snapshot" },
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({ url: "https://openclaw.ai/home", targetId: "t1" }),
        }],
      },
    }, ownerCtx);

    expect(store.getActive(ownerCtx.sessionKey)!.maxTaint).toBe("trusted");

    // Simulate tool completing and LLM making a second call in same turn
    api.fire("after_llm_call", {
      iteration: 2,
      toolCalls: [{
        name: "browser",
        arguments: { action: "snapshot" },
      }],
    }, ownerCtx);

    // Turn 1, second snapshot: untrusted site — escalates
    api.fire("after_tool_call", {
      toolName: "browser",
      params: { action: "snapshot" },
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({ url: "https://hackers.com/recruit", targetId: "t2" }),
        }],
      },
    }, ownerCtx);

    const graph = store.getActive(ownerCtx.sessionKey);
    expect(graph!.maxTaint).toBe("untrusted");
  });
});
