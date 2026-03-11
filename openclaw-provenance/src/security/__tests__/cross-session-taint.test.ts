/**
 * Cross-Session Taint Inheritance — Test Suite
 *
 * Validates that subagents inherit taint from their parent sessions,
 * preventing taint laundering via spawn.
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

describe("Cross-session taint inheritance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-xsession-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("subagent inherits taint from parent's in-flight graph", () => {
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

    const parentSession = "agent:main:main";
    const childSession = "agent:main:subagent:child-1";

    // Parent turn starts in a group context (owner DM exception won't apply,
    // so message.read will taint the context to external)
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });

    // Parent reads external content
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });

    // after_tool_call evaluates taint → escalates to external
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });

    // Parent spawns subagent (parent's turn is still in-flight)
    // Child's context_assembled fires
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // Check that the child inherited taint
    const inheritLog = logger.logs.find(l =>
      l.includes("PARENT_TAINT_INHERITANCE") && l.includes(childSession.slice(-8)),
    );
    expect(inheritLog).toBeDefined();
    expect(inheritLog).toContain("external");

    // Child tries to use exec → should be blocked (confirm mode at external taint)
    const result = api.fire("before_llm_call", {
      iteration: 0,
      tools: [{ name: "exec" }, { name: "read" }],
      messages: [],
    }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // exec should be removed
    expect(result?.tools).toBeDefined();
    const remainingNames = result.tools.map((t: any) => t.name);
    expect(remainingNames).not.toContain("exec");
    expect(remainingNames).toContain("read"); // safe tool stays
  });

  it("subagent from clean parent starts with trusted taint", () => {
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

    const parentSession = "agent:main:main";
    const childSession = "agent:main:subagent:child-2";

    // Parent turn starts — clean, no external content
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });

    // Parent only uses trusted tools
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "exec" }],
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });

    // after_tool_call: exec is trusted — no escalation
    api.fire("after_tool_call", {
      toolName: "exec",
      params: {},
      result: { content: [{ type: "text", text: "ok" }] },
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });

    // Child's context_assembled fires
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // No parent taint inheritance log
    const inheritLog = logger.logs.find(l =>
      l.includes("PARENT_TAINT_INHERITANCE") && l.includes(childSession.slice(-8)),
    );
    expect(inheritLog).toBeUndefined();

    // Child can use exec freely
    const result = api.fire("before_llm_call", {
      iteration: 0,
      tools: [{ name: "exec" }, { name: "read" }],
      messages: [],
    }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // No tools removed (allow mode) — may return systemPrompt for taint introspection
    expect(result?.block).toBeUndefined();
    expect((result as any)?.tools).toBeUndefined();
  });

  it("subagent inherits taint from parent's persisted watermark", () => {
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

    const parentSession = "agent:main:main";
    const childSession = "agent:main:subagent:child-3";

    // Parent turn 1: reads external content in a group context and completes
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });
    // after_tool_call: taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });
    // Complete the turn → flushes watermark
    api.fire("before_response_emit", { content: "done" }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });

    // Parent turn 2: spawns a subagent (new turn, inherits watermark)
    api.fire("context_assembled", { systemPrompt: "", messageCount: 2 }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });

    // Child starts — should inherit parent's persisted watermark
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    const inheritLog = logger.logs.find(l =>
      l.includes("PARENT_TAINT_INHERITANCE") && l.includes(childSession.slice(-8)),
    );
    expect(inheritLog).toBeDefined();
    expect(inheritLog).toContain("external");
  });

  it("subagent inherits untrusted taint from parent with web_fetch", () => {
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

    const parentSession = "agent:main:main";
    const childSession = "agent:main:subagent:child-4";

    // Parent reads web content → untrusted
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_fetch" }],
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });
    // after_tool_call: web_fetch is untrusted
    api.fire("after_tool_call", {
      toolName: "web_fetch",
      params: {},
      result: { content: [{ type: "text", text: "fetched content" }] },
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });

    // Child starts
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    const inheritLog = logger.logs.find(l =>
      l.includes("PARENT_TAINT_INHERITANCE") && l.includes(childSession.slice(-8)),
    );
    expect(inheritLog).toBeDefined();
    expect(inheritLog).toContain("untrusted");
  });

  it("per-agent overrides still apply to inherited taint", () => {
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
          taintPolicy: {
            external: "allow",
          },
        },
      },
    };

    registerSecurityHooks(api, logger, config);

    const parentSession = "agent:main:main";
    const childSession = "agent:tank:subagent:child-5";

    // Parent reads external content
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });
    // after_tool_call: taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
    });

    // Tank subagent starts — inherits external taint
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "tank",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // Tank's policy: external = allow → exec should still be available
    const result = api.fire("before_llm_call", {
      iteration: 0,
      tools: [{ name: "exec" }, { name: "read" }],
      messages: [],
    }, {
      agentId: "tank",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // Tank allows exec at external — no tools removed (may return systemPrompt)
    expect(result?.block).toBeUndefined();
    expect((result as any)?.tools).toBeUndefined();
  });
});

describe("Owner DM exception narrowing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-ownerdm-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("subagent does NOT get owner DM exception for message tool", () => {
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

    const parentSession = "agent:main:main";
    const childSession = "agent:main:subagent:child-dm-1";

    // Parent reads external content in a group context (so message.read taints)
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });
    // after_tool_call: taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, {
      agentId: "main",
      sessionKey: parentSession,
      senderIsOwner: true,
      groupId: "group-1",
    });

    // Child inherits external taint from parent
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // Child tries to call message tool — should be evaluated by policy, not bypassed.
    // Previously, spawnedBy would grant "owner DM" exception. Now it doesn't.
    const result = api.fire("before_tool_call", {
      toolName: "message",
      params: { action: "send", message: "hello" },
    }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
      // No groupId → would previously qualify as "owner DM" via spawnedBy
    });

    // message.send has a composite override allowing it at all taint levels,
    // so it goes through even without the owner DM exception.
    // But the bare "message" tool at "confirm" mode should be caught
    // by the real-time policy re-evaluation if the composite key doesn't match.
    // Since message.send IS explicitly allowed via DEFAULT_COMPOSITE_TOOL_OVERRIDES,
    // the before_tool_call composite key check lets it through.
    // This is correct: message.send is safe (output-only), message.read is not.
    // Let's verify message.read (data-incorporating action) IS blocked instead:
    const readResult = api.fire("before_tool_call", {
      toolName: "message",
      params: { action: "read" },
    }, {
      agentId: "main",
      sessionKey: childSession,
      spawnedBy: parentSession,
    });

    // message (bare tool) at external taint with confirm policy → blocked
    // The composite key "message.read" has no explicit "allow" override,
    // so it falls through to the bare tool policy evaluation.
    expect(readResult?.block).toBe(true);
  });

  it("actual owner DM still gets exception", () => {
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

    const session = "agent:main:main";

    // Owner session reads external content
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, {
      agentId: "main",
      sessionKey: session,
      senderIsOwner: true,
    });
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, {
      agentId: "main",
      sessionKey: session,
      senderIsOwner: true,
    });
    // after_tool_call: message.read in owner DM → trusted (owner DM exception)
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, {
      agentId: "main",
      sessionKey: session,
      senderIsOwner: true,
    });

    // Owner DM: senderIsOwner=true, no groupId, no spawnedBy → exception applies
    const result = api.fire("before_tool_call", {
      toolName: "message",
      params: { action: "send", message: "hello" },
    }, {
      agentId: "main",
      sessionKey: session,
      senderIsOwner: true,
      // No groupId, no spawnedBy → genuine owner DM
    });

    // Message send should be allowed (owner DM exception)
    expect(result?.block).toBeUndefined();
  });
});

describe("Watermark pruning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-prune-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pruneOlderThan removes stale entries", async () => {
    // Import WatermarkStore directly to test the method
    const { WatermarkStore } = await import("../watermark-store.js");
    const ws = new WatermarkStore(tmpDir);

    // Create an entry with a backdated timestamp
    ws.escalate("old-session", "external", "web_fetch", "web_fetch");
    ws.flush();

    // Manually backdate the entry
    const { readFileSync, writeFileSync } = await import("node:fs");
    const filePath = join(tmpDir, ".provenance", "watermarks.json");
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    data.watermarks["old-session"].escalatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(filePath, JSON.stringify(data), "utf-8");

    // Reload and prune
    const ws2 = new WatermarkStore(tmpDir);
    const pruned = ws2.pruneOlderThan(1000); // 1 second — old entry is way older
    expect(pruned).toBe(1);
    expect(ws2.getLevel("old-session")).toBeUndefined();
  });

  it("pruneOlderThan keeps recent entries", async () => {
    const { WatermarkStore } = await import("../watermark-store.js");
    const ws = new WatermarkStore(tmpDir);

    ws.escalate("recent-session", "external", "web_fetch", "web_fetch");
    const pruned = ws.pruneOlderThan(24 * 60 * 60 * 1000); // 24h
    expect(pruned).toBe(0);
    expect(ws.getLevel("recent-session")?.level).toBe("external");
  });
});
