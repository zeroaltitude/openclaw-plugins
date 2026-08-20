/**
 * Cross-Session Taint Inheritance — Test Suite
 *
 * Validates that subagents inherit taint from their parent sessions,
 * preventing taint laundering via spawn.
 *
 * Identity here follows production, not the old shim auto-seed:
 *   - ownership comes from the configured `ownerNumbers` list plus the
 *     `senderId` mainline puts on a user turn's hook ctx;
 *   - `groupId` comes from `seedIdentity()`, standing in for the
 *     `inbound_claim` handler — the hook ctx never carries it;
 *   - the parent→child link comes from firing the real `subagent_spawned`
 *     hook, which is what writes `spawnedBy` in production. Sub-agent turns
 *     get no identity fields on their ctx at all (mainline strips them for
 *     every `trigger !== "user"`).
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

const OWNER_ID = "owner-123";
const OWNER_NUMBERS = [OWNER_ID];

/** A genuine user turn: senderId + messageProvider, nothing else. */
function userCtx(sessionKey: string, agentId = "main") {
  return { agentId, sessionKey, senderId: OWNER_ID, messageProvider: "slack" };
}

/** A sub-agent turn: mainline strips identity for non-user triggers. */
function subagentCtx(sessionKey: string, agentId = "main") {
  return { agentId, sessionKey };
}

/**
 * Record the owner's identity for a GROUP session, as `inbound_claim` would.
 * `groupId` has no route onto the agent hook ctx, so a group scenario has to
 * come from the identity store. senderId matches the hook ctx and the
 * recomputed owner flag agrees with `ownerNumbers`, so the plugin's own
 * before_prompt_build seed finds nothing to correct and the groupId survives.
 */
function seedGroupOwner(tmpDir: string, sessionKey: string, groupId: string) {
  seedIdentity(tmpDir, sessionKey, {
    senderId: OWNER_ID,
    senderIsOwner: true,
    groupId,
    sourceProvider: "slack",
  });
}

/** Fire the hook that records a parent→child spawn in the identity store. */
function fireSpawn(
  api: ReturnType<typeof makeApi>,
  parentSessionKey: string,
  childSessionKey: string,
) {
  api.fire("subagent_spawned", { parentSessionKey, childSessionKey }, {});
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
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      ownerNumbers: OWNER_NUMBERS,
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
    seedGroupOwner(tmpDir, parentSession, "group-1");
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(parentSession));

    // Parent reads external content
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, userCtx(parentSession));

    // after_tool_call evaluates taint → escalates to external
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, userCtx(parentSession));

    // Parent spawns subagent (parent's turn is still in-flight)
    // Child's context_assembled fires
    fireSpawn(api, parentSession, childSession);
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, subagentCtx(childSession));

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
    }, subagentCtx(childSession));

    // exec should be removed
    expect(result?.tools).toBeDefined();
    const remainingNames = result.tools.map((t: any) => t.name);
    expect(remainingNames).not.toContain("exec");
    expect(remainingNames).toContain("read"); // safe tool stays
  });

  it("subagent from clean parent starts with trusted taint", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      ownerNumbers: OWNER_NUMBERS,
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
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(parentSession));

    // Parent only uses trusted tools
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "exec" }],
    }, userCtx(parentSession));

    // after_tool_call: exec is trusted — no escalation
    api.fire("after_tool_call", {
      toolName: "exec",
      params: {},
      result: { content: [{ type: "text", text: "ok" }] },
    }, userCtx(parentSession));

    // Child's context_assembled fires
    fireSpawn(api, parentSession, childSession);
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, subagentCtx(childSession));

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
    }, subagentCtx(childSession));

    // No tools removed (allow mode) — may return systemPrompt for taint introspection
    expect(result?.block).toBeUndefined();
    expect((result as any)?.tools).toBeUndefined();
  });

  it("subagent inherits taint from parent's persisted watermark", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      ownerNumbers: OWNER_NUMBERS,
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
    seedGroupOwner(tmpDir, parentSession, "group-1");
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(parentSession));
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, userCtx(parentSession));
    // after_tool_call: taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, userCtx(parentSession));
    // Complete the turn → flushes watermark
    api.fire("before_response_emit", { content: "done" }, userCtx(parentSession));

    // Parent turn 2: spawns a subagent (new turn, inherits watermark)
    api.fire("context_assembled", { systemPrompt: "", messageCount: 2 }, userCtx(parentSession));

    // Child starts — should inherit parent's persisted watermark
    fireSpawn(api, parentSession, childSession);
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, subagentCtx(childSession));

    const inheritLog = logger.logs.find(l =>
      l.includes("PARENT_TAINT_INHERITANCE") && l.includes(childSession.slice(-8)),
    );
    expect(inheritLog).toBeDefined();
    expect(inheritLog).toContain("external");
  });

  it("subagent inherits untrusted taint from parent with web_fetch", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      ownerNumbers: OWNER_NUMBERS,
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
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(parentSession));
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "web_fetch" }],
    }, userCtx(parentSession));
    // after_tool_call: web_fetch is untrusted
    api.fire("after_tool_call", {
      toolName: "web_fetch",
      params: {},
      result: { content: [{ type: "text", text: "fetched content" }] },
    }, userCtx(parentSession));

    // Child starts
    fireSpawn(api, parentSession, childSession);
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, subagentCtx(childSession));

    const inheritLog = logger.logs.find(l =>
      l.includes("PARENT_TAINT_INHERITANCE") && l.includes(childSession.slice(-8)),
    );
    expect(inheritLog).toBeDefined();
    expect(inheritLog).toContain("untrusted");
  });

  it("per-agent overrides still apply to inherited taint", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      ownerNumbers: OWNER_NUMBERS,
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
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(parentSession));
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, userCtx(parentSession));
    // after_tool_call: taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, userCtx(parentSession));

    // Tank subagent starts — inherits external taint
    fireSpawn(api, parentSession, childSession);
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, subagentCtx(childSession, "tank"));

    // Tank's policy: external = allow → exec should still be available
    const result = api.fire("before_llm_call", {
      iteration: 0,
      tools: [{ name: "exec" }, { name: "read" }],
      messages: [],
    }, subagentCtx(childSession, "tank"));

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
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      ownerNumbers: OWNER_NUMBERS,
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
    seedGroupOwner(tmpDir, parentSession, "group-1");
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(parentSession));
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, userCtx(parentSession));
    // after_tool_call: taint evaluated post-execution
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, userCtx(parentSession));

    // Child inherits external taint from parent
    fireSpawn(api, parentSession, childSession);
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, subagentCtx(childSession));

    // Child tries to call message tool — should be evaluated by policy, not bypassed.
    // Previously, spawnedBy would grant "owner DM" exception. Now it doesn't.
    const result = api.fire("before_tool_call", {
      toolName: "message",
      params: { action: "send", message: "hello" },
    }, subagentCtx(childSession));

    // message.send has a composite override allowing it at all taint levels,
    // so it goes through even without the owner DM exception.
    // But the bare "message" tool at "confirm" mode should be caught
    // by the real-time policy re-evaluation if the composite key doesn't match.
    // Since message.send IS explicitly allowed via DEFAULT_COMPOSITE_TOOL_OVERRIDES,
    // the before_tool_call composite key check lets it through.
    // This is correct: message.send is safe (output-only). message reads are
    // now input operations allowed up to external (they cannot exfiltrate),
    // so probe with a genuinely gated action instead — exec is restricted at
    // external. A subagent that inherited the parent's external taint must NOT
    // bypass that gate just because it was spawned by an owner session.
    const execResult = api.fire("before_tool_call", {
      toolName: "exec",
      params: { command: "echo hi" },
    }, subagentCtx(childSession));

    // exec at external taint → blocked (no owner-DM bypass for subagents)
    expect(execResult?.block).toBe(true);
  });

  it("actual owner DM still gets exception", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const config: SecurityPluginConfig = {
      workspaceDir: tmpDir,
      // The exception hangs off senderIsOwner, which the plugin may only
      // derive from this list — there is no ctx field that grants it.
      ownerNumbers: OWNER_NUMBERS,
      taintPolicy: {
        trusted: "allow",
        external: "confirm",
        untrusted: "confirm",
      },
    };

    registerSecurityHooks(api, logger, config);

    const session = "agent:main:main";

    // Owner session reads external content
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(session));
    api.fire("after_llm_call", {
      iteration: 0,
      toolCalls: [{ name: "message", params: { action: "read" } }],
    }, userCtx(session));
    // after_tool_call: message.read in owner DM → trusted (owner DM exception)
    api.fire("after_tool_call", {
      toolName: "message",
      params: { action: "read" },
      result: { content: [{ type: "text", text: "message content" }] },
    }, userCtx(session));

    // Owner DM: senderIsOwner=true (from ownerNumbers), no groupId, no
    // spawnedBy → exception applies
    const result = api.fire("before_tool_call", {
      toolName: "message",
      params: { action: "send", message: "hello" },
    }, userCtx(session));

    // Message send should be allowed (owner DM exception)
    expect(result?.block).toBeUndefined();
  });

  /**
   * The exception is only observable on a message action that policy would
   * otherwise stop: `message.read` is "restrict" at untrusted taint (
   * DEFAULT_COMPOSITE_TOOL_OVERRIDES), while `message.send` is "allow" at
   * every level and so cannot discriminate. Taint the session to untrusted
   * with web_fetch, then probe message.read.
   */
  function taintToUntrustedThenProbeMessageRead(
    api: ReturnType<typeof makeApi>,
    session: string,
  ) {
    api.fire("context_assembled", { systemPrompt: "", messageCount: 1 }, userCtx(session));
    api.fire("after_tool_call", {
      toolName: "web_fetch",
      params: {},
      result: { content: [{ type: "text", text: "fetched content" }] },
    }, userCtx(session));
    return api.fire("before_tool_call", {
      toolName: "message",
      params: { action: "read", channel: "general" },
    }, userCtx(session));
  }

  it("grants the owner DM exception when ownerNumbers names the sender", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    registerSecurityHooks(api, logger, {
      workspaceDir: tmpDir,
      ownerNumbers: OWNER_NUMBERS,
      // "restrict" is the canonical mode; the legacy "confirm" used elsewhere
      // in this file normalizes to exactly this (normalizePolicyMode).
      taintPolicy: { trusted: "allow", external: "restrict", untrusted: "restrict" },
    });

    const result = taintToUntrustedThenProbeMessageRead(api, "agent:main:main");

    // Owner DM → exception → allowed despite untrusted taint.
    expect(result?.block).toBeUndefined();
  });

  it("denies the owner DM exception to a sender absent from ownerNumbers", () => {
    // Counterpart to the test above — identical session, hooks and probe; only
    // the ownerNumbers list differs. Under the shim's old auto-seed a test
    // could hand itself `senderIsOwner: true` on the ctx and take the
    // exception with no ownerNumbers entry at all, so this pair could not have
    // been written.
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    registerSecurityHooks(api, logger, {
      workspaceDir: tmpDir,
      ownerNumbers: ["somebody-else"],
      // "restrict" is the canonical mode; the legacy "confirm" used elsewhere
      // in this file normalizes to exactly this (normalizePolicyMode).
      taintPolicy: { trusted: "allow", external: "restrict", untrusted: "restrict" },
    });

    const result = taintToUntrustedThenProbeMessageRead(api, "agent:main:main");

    // Not the owner → message.read is restricted at untrusted taint.
    expect(result?.block).toBe(true);
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
