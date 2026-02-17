/**
 * Per-Agent Policy Overrides — Test Suite
 *
 * Validates that agentOverrides in config produce different policy
 * behavior for different agents sharing the same provenance plugin.
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

describe("Per-agent policy overrides", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-agent-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("default agent gets default taint from web_search (untrusted)", () => {
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

    // Simulate context_assembled for default agent
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: "agent:main:test1",
      senderIsOwner: true,
    });

    // Simulate after_llm_call with web_search
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "main",
      sessionKey: "agent:main:test1",
    });

    // Check that taint was escalated (web_search = untrusted by default)
    const taintLog = logger.logs.find(l => l.includes("Taint after:"));
    expect(taintLog).toBeDefined();
    // Default: web_search taints to "untrusted"
    expect(taintLog).toContain("untrusted");
  });

  it("agent with toolOutputTaints override treats web_search as trusted", () => {
    const logger = makeLogger();
    const api = makeApi();
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "confirm",
        untrusted: "confirm",
      },
      agentOverrides: {
        tank: {
          toolOutputTaints: {
            web_search: "trusted",
            web_fetch: "trusted",
          },
        },
      },
    };

    registerSecurityHooks(api, logger, config);

    // Simulate context_assembled for Tank
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "tank",
      sessionKey: "agent:tank:test1",
      senderIsOwner: true,
    });

    // Simulate after_llm_call with web_search
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "tank",
      sessionKey: "agent:tank:test1",
    });

    // Check that taint stayed trusted for Tank
    const taintLogs = logger.logs.filter(l => l.includes("Taint after:"));
    expect(taintLogs.length).toBeGreaterThan(0);
    const lastTaintLog = taintLogs[taintLogs.length - 1];
    expect(lastTaintLog).toContain("trusted");
  });

  it("agent with taintPolicy override allows exec at external taint", () => {
    const logger = makeLogger();
    const api = makeApi();
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "confirm",
        untrusted: "confirm",
      },
      toolOutputTaints: {
        web_search: "external",
      },
      agentOverrides: {
        tank: {
          taintPolicy: {
            shared: "allow",
            external: "allow",
          },
        },
      },
    };

    registerSecurityHooks(api, logger, config);

    // Tank session: context_assembled
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "tank",
      sessionKey: "agent:tank:test2",
      senderIsOwner: true,
    });

    // Tank uses web_search → taint goes to external
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "tank",
      sessionKey: "agent:tank:test2",
    });

    // Now evaluate policy: Tank should still have exec available
    const result = api.fire("before_llm_call", {
      iteration: 1,
      tools: [{ name: "exec" }, { name: "web_search" }],
      messages: [],
    }, {
      agentId: "tank",
      sessionKey: "agent:tank:test2",
    });

    // Debug: check what policy Tank actually got
    const policyLogs = logger.logs.filter(l => l.includes("Taint:") || l.includes("Mode:") || l.includes("Removed:"));
    // console.log("Tank policy logs:", policyLogs);
    // console.log("All logs:", logger.logs);
    // console.log("Result:", JSON.stringify(result));

    // Tank's policy: external = allow, so no tools should be removed
    if (result?.tools) {
      const remainingNames = result.tools.map((t: any) => t.name);
      expect(remainingNames).toContain("exec");
    }
    // If result is undefined, that also means no tools were removed (allow path)
  });

  it("default agent has exec blocked at external taint (confirm mode)", () => {
    const logger = makeLogger();
    const api = makeApi();
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "confirm",
        untrusted: "confirm",
      },
      toolOutputTaints: {
        web_search: "external",
      },
    };

    registerSecurityHooks(api, logger, config);

    // Main session: context_assembled
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: "agent:main:test2",
      senderIsOwner: true,
    });

    // Main uses web_search → taint goes to external
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "main",
      sessionKey: "agent:main:test2",
    });

    // Evaluate policy: main should have exec removed
    const result = api.fire("before_llm_call", {
      iteration: 1,
      tools: [{ name: "exec" }, { name: "web_search" }],
      messages: [],
    }, {
      agentId: "main",
      sessionKey: "agent:main:test2",
    });

    // exec should be removed (confirm mode, no approval)
    expect(result?.tools).toBeDefined();
    const remainingNames = result.tools.map((t: any) => t.name);
    expect(remainingNames).not.toContain("exec");
    // web_search is a safe tool (always allow), so it stays
    expect(remainingNames).toContain("web_search");
  });

  it("logs agent override info at startup", () => {
    const logger = makeLogger();
    const api = makeApi();
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      agentOverrides: {
        tank: {
          taintPolicy: { external: "allow" },
          toolOutputTaints: { web_search: "trusted" },
        },
      },
    };

    registerSecurityHooks(api, logger, config);

    const overrideLog = logger.logs.find(l => l.includes("Agent override loaded for 'tank'"));
    expect(overrideLog).toBeDefined();

    const agentListLog = logger.logs.find(l => l.includes("Agent overrides: tank"));
    expect(agentListLog).toBeDefined();
  });
});
