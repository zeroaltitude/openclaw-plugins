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
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "restrict",
        untrusted: "restrict",
      },
    };

    registerSecurityHooks(api, logger, config);

    // Simulate context_assembled for default agent
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: "agent:main:test1",
      senderIsOwner: true,
    });

    // after_llm_call logs proposed tools (no escalation)
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "main",
      sessionKey: "agent:main:test1",
    });

    // after_tool_call: taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "web_search",
      params: {},
      result: { content: [{ type: "text", text: "search results" }] },
    }, {
      agentId: "main",
      sessionKey: "agent:main:test1",
    });

    // Check that taint was escalated (web_search = untrusted by default)
    const taintLog = logger.logs.find(l => l.includes("TOOL_TAINT_ESCALATION"));
    expect(taintLog).toBeDefined();
    // Default: web_search taints to "untrusted"
    expect(taintLog).toContain("untrusted");
  });

  it("agent with toolOutputTaints override treats web_search as trusted", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "restrict",
        untrusted: "restrict",
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

    // after_llm_call logs proposed tools (no escalation)
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "tank",
      sessionKey: "agent:tank:test1",
    });

    // after_tool_call: taint evaluated with Tank's overrides (web_search = trusted)
    api.fire("after_tool_call", {
      toolName: "web_search",
      params: {},
      result: { content: [{ type: "text", text: "search results" }] },
    }, {
      agentId: "tank",
      sessionKey: "agent:tank:test1",
    });

    // Check that taint stayed trusted for Tank (no escalation log)
    const escalationLog = logger.logs.find(l => l.includes("TOOL_TAINT_ESCALATION"));
    expect(escalationLog).toBeUndefined();

    // Graph taint should still be trusted
    const taintLog = logger.logs.find(l => l.includes("Established taint:"));
    expect(taintLog).toBeDefined();
    expect(taintLog).toContain("trusted");
  });

  it("agent with taintPolicy+toolOverride allows exec at external taint", () => {
    // exec now has a per-tool override: external → "restrict". To allow exec at external
    // for a specific agent, both taintPolicy AND toolOverrides must be set. taintPolicy
    // alone is insufficient because per-tool overrides beat the taint policy default.
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "restrict",
        untrusted: "restrict",
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
          // Must also explicitly override exec's per-tool restriction at external
          toolOverrides: {
            exec: { trusted: "allow", shared: "allow", external: "allow", untrusted: "restrict" },
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

    // Tank uses web_search
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "tank",
      sessionKey: "agent:tank:test2",
    });

    // after_tool_call: taint evaluated → external
    api.fire("after_tool_call", {
      toolName: "web_search",
      params: {},
      result: { content: [{ type: "text", text: "search results" }] },
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

    // Tank's policy: external = allow + explicit exec toolOverride, so exec is not removed
    if (result?.tools) {
      const remainingNames = result.tools.map((t: any) => t.name);
      expect(remainingNames).toContain("exec");
    }
    // If result is undefined, that also means no tools were removed (allow path)
  });

  it("default agent has exec blocked at external taint (restrict mode)", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      taintPolicy: {
        trusted: "allow",
        external: "restrict",
        untrusted: "restrict",
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

    // Main uses web_search
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_search" }],
    }, {
      agentId: "main",
      sessionKey: "agent:main:test2",
    });

    // after_tool_call: taint evaluated → external
    api.fire("after_tool_call", {
      toolName: "web_search",
      params: {},
      result: { content: [{ type: "text", text: "search results" }] },
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
    const api = makeApi(tmpDir);
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
