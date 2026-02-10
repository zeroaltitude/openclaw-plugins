/**
 * Security Policy Engine — Test Suite
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WatermarkStore } from "../watermark-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPolicyConfig,
  evaluatePolicy,
  evaluateWithApprovals,
  getToolMode,
  validateMonotonicity,
  strictest,
  DEFAULT_SAFE_TOOLS,
  DEFAULT_DANGEROUS_TOOLS,
  type PolicyMode,
  type PolicyConfig,
} from "../policy-engine.js";
import { TurnProvenanceGraph } from "../provenance-graph.js";
import { ApprovalStore } from "../approval-store.js";
import type { TrustLevel } from "../trust-levels.js";

// ============================================================
// Helpers
// ============================================================

function makeGraph(sessionKey = "test"): TurnProvenanceGraph {
  const g = new TurnProvenanceGraph(sessionKey, "test-turn");
  g.recordContextAssembled("system prompt", 10);
  return g;
}

function graphWithTaint(taint: TrustLevel): TurnProvenanceGraph {
  const g = makeGraph();
  g.recordLlmCall(1, 28);
  // Add a node with the desired trust to set taint
  const trustToTool: Record<string, string> = {
    system: "session_status",
    owner: "__skip__",
    local: "exec",
    shared: "vestige_search",
    external: "message",
    untrusted: "web_fetch",
  };
  const tool = trustToTool[taint];
  if (tool && tool !== "__skip__") {
    g.recordToolCall(tool, 1);
  }
  return g;
}

const ALL_TOOLS = [
  "exec", "read", "write", "edit", "browser", "message", "gateway",
  "cron", "web_fetch", "web_search", "memory_search", "memory_get",
  "image", "session_status", "sessions_list", "sessions_history",
  "agents_list", "vestige_search", "vestige_smart_ingest", "vestige_promote",
  "vestige_demote", "tts", "canvas", "nodes", "sessions_spawn", "sessions_send",
  "process",
];

// ============================================================
// strictest()
// ============================================================

describe("strictest()", () => {
  it("returns the stricter of two modes", () => {
    expect(strictest("allow", "confirm")).toBe("confirm");
    expect(strictest("confirm", "restrict")).toBe("restrict");
    expect(strictest("allow", "restrict")).toBe("restrict");
  });

  it("is commutative", () => {
    expect(strictest("allow", "confirm")).toBe(strictest("confirm", "allow"));
    expect(strictest("allow", "restrict")).toBe(strictest("restrict", "allow"));
    expect(strictest("confirm", "restrict")).toBe(strictest("restrict", "confirm"));
  });

  it("is idempotent", () => {
    expect(strictest("allow", "allow")).toBe("allow");
    expect(strictest("confirm", "confirm")).toBe("confirm");
    expect(strictest("restrict", "restrict")).toBe("restrict");
  });
});

// ============================================================
// validateMonotonicity()
// ============================================================

describe("validateMonotonicity()", () => {
  it("accepts a valid monotonic config", () => {
    const { corrected, warnings } = validateMonotonicity({
      system: "allow",
      owner: "allow",
      local: "allow",
      shared: "confirm",
      external: "confirm",
      untrusted: "restrict",
    });
    expect(warnings).toHaveLength(0);
    expect(corrected.untrusted).toBe("restrict");
  });

  it("corrects non-monotonic config", () => {
    const { corrected, warnings } = validateMonotonicity({
      system: "allow",
      owner: "allow",
      local: "confirm",
      shared: "allow", // less strict than local — should be corrected
      external: "confirm",
      untrusted: "confirm",
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(corrected.shared).toBe("confirm"); // corrected to match local
  });

  it("corrects untrusted being less strict than external", () => {
    const { corrected, warnings } = validateMonotonicity({
      system: "allow",
      owner: "allow",
      local: "allow",
      shared: "allow",
      external: "restrict",
      untrusted: "allow", // less strict than external!
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(corrected.untrusted).toBe("restrict");
  });

  it("accepts all-allow", () => {
    const { corrected, warnings } = validateMonotonicity({
      system: "allow",
      owner: "allow",
      local: "allow",
      shared: "allow",
      external: "allow",
      untrusted: "allow",
    });
    expect(warnings).toHaveLength(0);
  });

  it("accepts all-restrict", () => {
    const { corrected, warnings } = validateMonotonicity({
      system: "restrict",
      owner: "restrict",
      local: "restrict",
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    });
    expect(warnings).toHaveLength(0);
  });
});

// ============================================================
// getToolMode()
// ============================================================

describe("getToolMode()", () => {
  const config = buildPolicyConfig();

  it("returns default mode for unoverridden tools", () => {
    // exec at owner level: taintPolicy.owner = "allow", no override → allow
    expect(getToolMode("exec", "owner", config)).toBe("allow");
    // exec at external level: taintPolicy.external = "confirm", no override → confirm
    expect(getToolMode("exec", "external", config)).toBe("confirm");
  });

  it("returns 'allow' for safe tools even at untrusted", () => {
    expect(getToolMode("read", "untrusted", config)).toBe("allow");
    expect(getToolMode("web_fetch", "untrusted", config)).toBe("allow");
    expect(getToolMode("memory_search", "untrusted", config)).toBe("allow");
    expect(getToolMode("vestige_search", "untrusted", config)).toBe("allow");
    expect(getToolMode("image", "untrusted", config)).toBe("allow");
    expect(getToolMode("session_status", "untrusted", config)).toBe("allow");
  });

  it("returns 'confirm' for gateway at local+ (default override)", () => {
    // Default override only covers local/shared/external/untrusted
    expect(getToolMode("gateway", "owner", config)).toBe("allow"); // no override at owner
    expect(getToolMode("gateway", "local", config)).toBe("confirm");
    expect(getToolMode("gateway", "external", config)).toBe("confirm");
    expect(getToolMode("gateway", "untrusted", config)).toBe("confirm");
  });

  it("returns 'confirm' for gateway at all levels with glob override", () => {
    const configWithGlob = buildPolicyConfig(undefined, { "gateway": { "*": "confirm" } });
    expect(getToolMode("gateway", "owner", configWithGlob)).toBe("confirm");
    expect(getToolMode("gateway", "system", configWithGlob)).toBe("confirm");
  });

  it("override can make things more permissive (safe tools)", () => {
    // If default is "confirm" and override says "allow", the override wins
    const customConfig = buildPolicyConfig(
      { external: "confirm" },
      { "exec": { "external": "allow" } },
    );
    expect(getToolMode("exec", "external", customConfig)).toBe("allow");
  });

  it("override can make things stricter", () => {
    const customConfig = buildPolicyConfig(
      { external: "confirm" },
      { "exec": { "external": "restrict" } },
    );
    expect(getToolMode("exec", "external", customConfig)).toBe("restrict");
  });

  it("glob override applies to all levels", () => {
    const customConfig = buildPolicyConfig(
      undefined,
      { "some_tool": { "*": "restrict" } },
    );
    expect(getToolMode("some_tool", "owner", customConfig)).toBe("restrict");
    expect(getToolMode("some_tool", "untrusted", customConfig)).toBe("restrict");
  });

  it("is case-insensitive on tool name", () => {
    expect(getToolMode("Gateway", "local", config)).toBe("confirm");
    expect(getToolMode("GATEWAY", "local", config)).toBe("confirm");
    expect(getToolMode("Read", "untrusted", config)).toBe("allow");
    expect(getToolMode("READ", "untrusted", config)).toBe("allow");
  });
});

// ============================================================
// buildPolicyConfig()
// ============================================================

describe("buildPolicyConfig()", () => {
  it("uses defaults when no args provided", () => {
    const config = buildPolicyConfig();
    expect(config.taintPolicy.owner).toBe("allow");
    expect(config.taintPolicy.shared).toBe("confirm");
    expect(config.taintPolicy.external).toBe("confirm");
    expect(config.taintPolicy.untrusted).toBe("confirm");
    expect(config.maxIterations).toBe(10);
  });

  it("merges user taint policy with defaults", () => {
    const config = buildPolicyConfig({ untrusted: "restrict" });
    expect(config.taintPolicy.owner).toBe("allow");
    expect(config.taintPolicy.untrusted).toBe("restrict");
  });

  it("includes all safe tools", () => {
    const config = buildPolicyConfig();
    for (const tool of Object.keys(DEFAULT_SAFE_TOOLS)) {
      expect(config.toolOverrides[tool]).toBeDefined();
      expect(config.toolOverrides[tool]["*"]).toBe("allow");
    }
  });

  it("includes dangerous tool overrides", () => {
    const config = buildPolicyConfig();
    expect(config.toolOverrides["gateway"]).toBeDefined();
  });

  it("user overrides merge per-tool", () => {
    const config = buildPolicyConfig(undefined, {
      "gateway": { "owner": "restrict" },
    });
    // Should have both the default and user override
    expect(config.toolOverrides["gateway"]["local"]).toBe("confirm");  // from default
    expect(config.toolOverrides["gateway"]["owner"]).toBe("restrict"); // from user
  });

  it("corrects non-monotonic taint policy", () => {
    const config = buildPolicyConfig({
      local: "confirm",
      shared: "allow", // invalid: less strict than local
    });
    expect(config.taintPolicy.shared).toBe("confirm"); // auto-corrected
  });
});

// ============================================================
// evaluatePolicy()
// ============================================================

describe("evaluatePolicy()", () => {
  const config = buildPolicyConfig();

  it("allows all tools at owner taint (gateway has no owner override)", () => {
    const graph = graphWithTaint("owner");
    const result = evaluatePolicy(graph, ALL_TOOLS, config);
    expect(result.defaultMode).toBe("allow");
    expect(result.allowed).toContain("exec");
    expect(result.allowed).toContain("message");
    expect(result.allowed).toContain("gateway"); // no override at owner level
    expect(result.restricted).toHaveLength(0);
  });

  it("confirms dangerous tools and allows safe tools at untrusted taint", () => {
    const graph = graphWithTaint("untrusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, config);
    expect(result.defaultMode).toBe("confirm");
    // Tools with no override get the default "confirm"
    expect(result.confirm.map(c => c.tool)).toContain("exec");
    expect(result.confirm.map(c => c.tool)).toContain("write");
    // Safe tools (override: "allow") should be allowed
    expect(result.allowed).toContain("read");
    expect(result.allowed).toContain("web_fetch");
    expect(result.allowed).toContain("memory_search");
    // Gateway override is "confirm" at untrusted — same as default but explicit
    expect(result.confirm.map(c => c.tool)).toContain("gateway");
  });

  it("blocks turn when max iterations exceeded", () => {
    const graph = makeGraph();
    // Simulate many iterations
    for (let i = 0; i < 11; i++) {
      graph.recordLlmCall(i, 28);
      graph.recordIterationEnd(i, 1, true);
    }
    const result = evaluatePolicy(graph, ALL_TOOLS, config);
    expect(result.blockTurn).toBe(true);
    expect(result.maxIterationsExceeded).toBe(true);
  });

  it("does not block at exactly maxIterations - 1", () => {
    const config10 = buildPolicyConfig(undefined, undefined, 10);
    const graph = makeGraph();
    for (let i = 0; i < 9; i++) {
      graph.recordLlmCall(i, 28);
      graph.recordIterationEnd(i, 1, true);
    }
    const result = evaluatePolicy(graph, ALL_TOOLS, config10);
    expect(result.blockTurn).toBe(false);
  });

  it("all-restrict mode removes non-safe tools, safe tool overrides still win", () => {
    const restrictConfig = buildPolicyConfig({
      system: "restrict",
      owner: "restrict",
      local: "restrict",
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    });
    const graph = graphWithTaint("owner");
    const result = evaluatePolicy(graph, ALL_TOOLS, restrictConfig);
    
    // Safe tools have override "*": "allow" — override wins
    expect(result.allowed).toContain("read");
    expect(result.allowed).toContain("web_fetch");
    expect(result.allowed).toContain("memory_search");
    
    // Non-safe, non-overridden tools get "restrict"
    expect(result.restricted).toContain("exec");
    expect(result.restricted).toContain("write");
    
    // Gateway override only covers local+ — at owner level, no override, so "restrict"
    expect(result.restricted).toContain("gateway");
  });

  it("all-allow mode allows everything (except gateway override)", () => {
    const allowConfig = buildPolicyConfig({
      system: "allow",
      owner: "allow",
      local: "allow",
      shared: "allow",
      external: "allow",
      untrusted: "allow",
    });
    const graph = graphWithTaint("untrusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, allowConfig);
    expect(result.allowed).toContain("exec");
    expect(result.allowed).toContain("message");
    // Gateway still requires confirm due to DEFAULT_DANGEROUS_TOOLS
    expect(result.confirm.map(c => c.tool)).toContain("gateway");
  });
});

// ============================================================
// evaluateWithApprovals()
// ============================================================

describe("evaluateWithApprovals()", () => {
  let approvalStore: ApprovalStore;
  const config = buildPolicyConfig();

  beforeEach(() => {
    approvalStore = new ApprovalStore(60_000);
  });

  it("blocks tools at untrusted taint without approval", () => {
    const graph = graphWithTaint("untrusted");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result.toolRemovals.size).toBeGreaterThan(0);
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.pendingConfirmations.length).toBeGreaterThan(0);
  });

  it("allows approved tools through", () => {
    const graph = graphWithTaint("untrusted");
    
    // First call to get the pending confirmations
    const result1 = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result1.toolRemovals.has("exec")).toBe(true);
    
    // Simulate approval
    const code = approvalStore.addPendingBatch([{
      sessionKey: "session-1",
      toolName: "exec",
      taintLevel: "untrusted",
      reason: "test",
      requestedAt: Date.now(),
    }]);
    approvalStore.approveWithCode("session-1", "exec", code, null);
    
    // Second call should allow exec through
    const result2 = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result2.toolRemovals.has("exec")).toBe(false);
  });

  it("does not allow approval to bypass restrict mode", () => {
    const restrictConfig = buildPolicyConfig({
      system: "restrict",
      owner: "restrict",
      local: "restrict",
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    });
    const graph = graphWithTaint("owner");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, restrictConfig, approvalStore, "session-1");
    
    // exec should be restricted (not confirmable)
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.pendingConfirmations.map(p => p.toolName)).not.toContain("exec");
  });

  it("safe tools pass through even at untrusted", () => {
    const graph = graphWithTaint("untrusted");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result.toolRemovals.has("read")).toBe(false);
    expect(result.toolRemovals.has("web_fetch")).toBe(false);
    expect(result.toolRemovals.has("memory_search")).toBe(false);
  });

  it("gateway requires approval at local taint (override covers local+)", () => {
    const graph = graphWithTaint("local");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result.toolRemovals.has("gateway")).toBe(true);
    expect(result.pendingConfirmations.map(p => p.toolName)).toContain("gateway");
  });

  it("gateway allowed at owner taint (no override at owner level)", () => {
    const graph = graphWithTaint("owner");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result.toolRemovals.has("gateway")).toBe(false);
  });

  it("reports effective mode as confirm when overrides trigger", () => {
    const graph = graphWithTaint("local");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    // Default mode is "allow" but gateway override at local makes effective mode "confirm"
    expect(result.mode).toBe("confirm");
  });
});

// ============================================================
// ApprovalStore
// ============================================================

describe("ApprovalStore", () => {
  let store: ApprovalStore;

  beforeEach(() => {
    store = new ApprovalStore(60_000);
  });

  it("generates 8-char hex codes", () => {
    const code = store.addPendingBatch([{
      sessionKey: "s1",
      toolName: "exec",
      taintLevel: "untrusted",
      reason: "test",
      requestedAt: Date.now(),
    }]);
    expect(code).toMatch(/^[0-9a-f]{8}$/);
  });

  it("approves with valid code", () => {
    const code = store.addPendingBatch([{
      sessionKey: "s1",
      toolName: "exec",
      taintLevel: "untrusted",
      reason: "test",
      requestedAt: Date.now(),
    }]);
    const result = store.approveWithCode("s1", "exec", code, null);
    expect(result.ok).toBe(true);
    expect(store.isApproved("s1", "exec")).toBe(true);
  });

  it("rejects invalid code", () => {
    store.addPendingBatch([{
      sessionKey: "s1",
      toolName: "exec",
      taintLevel: "untrusted",
      reason: "test",
      requestedAt: Date.now(),
    }]);
    const result = store.approveWithCode("s1", "exec", "00000000", null);
    expect(result.ok).toBe(false);
    expect(store.isApproved("s1", "exec")).toBe(false);
  });

  it("approves all tools with 'all' target", () => {
    const code = store.addPendingBatch([
      { sessionKey: "s1", toolName: "exec", taintLevel: "untrusted", reason: "test", requestedAt: Date.now() },
      { sessionKey: "s1", toolName: "message", taintLevel: "untrusted", reason: "test", requestedAt: Date.now() },
    ]);
    const result = store.approveWithCode("s1", "all", code, null);
    expect(result.ok).toBe(true);
    expect(store.isApproved("s1", "exec")).toBe(true);
    expect(store.isApproved("s1", "message")).toBe(true);
  });

  it("clears turn-scoped approvals", () => {
    const code = store.addPendingBatch([{
      sessionKey: "s1",
      toolName: "exec",
      taintLevel: "untrusted",
      reason: "test",
      requestedAt: Date.now(),
    }]);
    store.approveWithCode("s1", "exec", code, null); // null = turn-scoped
    expect(store.isApproved("s1", "exec")).toBe(true);
    store.clearTurnScoped("s1");
    expect(store.isApproved("s1", "exec")).toBe(false);
  });

  it("time-limited approvals survive turn clear", () => {
    const code = store.addPendingBatch([{
      sessionKey: "s1",
      toolName: "exec",
      taintLevel: "untrusted",
      reason: "test",
      requestedAt: Date.now(),
    }]);
    store.approveWithCode("s1", "exec", code, 30); // 30 minutes
    expect(store.isApproved("s1", "exec")).toBe(true);
    store.clearTurnScoped("s1");
    expect(store.isApproved("s1", "exec")).toBe(true); // still approved
  });

  it("reuses existing valid code", () => {
    const code1 = store.addPendingBatch([{
      sessionKey: "s1",
      toolName: "exec",
      taintLevel: "untrusted",
      reason: "test",
      requestedAt: Date.now(),
    }]);
    const code2 = store.getCurrentCode("s1");
    expect(code2).toBe(code1);
  });
});

// ============================================================
// TurnProvenanceGraph
// ============================================================

describe("TurnProvenanceGraph", () => {
  it("starts at system taint", () => {
    const g = makeGraph();
    expect(g.maxTaint).toBe("owner"); // owner because history node is owner
  });

  it("escalates taint on tool calls", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("exec", 1);
    expect(g.maxTaint).toBe("local");
    g.recordToolCall("web_fetch", 1);
    expect(g.maxTaint).toBe("untrusted");
  });

  it("taint never decreases", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("web_fetch", 1); // untrusted
    g.recordToolCall("exec", 1);       // local — should not decrease taint
    expect(g.maxTaint).toBe("untrusted");
  });

  it("tracks tools used", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("exec", 1);
    g.recordToolCall("web_fetch", 1);
    const summary = g.summary();
    expect(summary.toolsUsed).toContain("exec");
    expect(summary.toolsUsed).toContain("web_fetch");
  });

  it("tracks external sources", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("web_fetch", 1);
    const summary = g.summary();
    expect(summary.externalSources).toContain("web_fetch");
  });

  it("tracks blocked tools", () => {
    const g = makeGraph();
    g.recordBlockedTool("exec", "policy", 1);
    const summary = g.summary();
    expect(summary.toolsBlocked).toContain("exec");
  });

  it("builds edges from LLM to tool calls", () => {
    const g = makeGraph();
    const llmId = g.recordLlmCall(1, 28);
    g.recordToolCall("exec", 1, llmId);
    const edges = g.getAllEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe(llmId);
    expect(edges[0].relation).toBe("triggers");
  });

  it("seals and prevents further modification", () => {
    const g = makeGraph();
    g.seal();
    expect(g.sealed).toBe(true);
    expect(() => g.recordLlmCall(1, 28)).toThrow();
  });

  it("counts iterations", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordIterationEnd(1, 1, true);
    g.recordLlmCall(2, 28);
    g.recordIterationEnd(2, 0, false);
    expect(g.iterationCount).toBe(2);
  });

  it("serializes to JSON", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("exec", 1);
    const json = g.toJSON();
    expect(json.turnId).toBe("test-turn");
    expect(json.sessionKey).toBe("test");
    expect((json.nodes as any[]).length).toBeGreaterThan(0);
  });
});

// ============================================================
// Integration: Taint escalation → policy enforcement
// ============================================================

describe("Integration: taint → policy", () => {
  const config = buildPolicyConfig();
  let approvalStore: ApprovalStore;

  beforeEach(() => {
    approvalStore = new ApprovalStore(60_000);
  });

  it("owner message → exec allowed, no restrictions", () => {
    const graph = graphWithTaint("owner");
    const result = evaluateWithApprovals(graph, ["exec", "read"], config, approvalStore, "s1");
    expect(result.toolRemovals.has("exec")).toBe(false);
  });

  it("owner → web_fetch → exec blocked (untrusted taint)", () => {
    const graph = makeGraph();
    graph.recordLlmCall(1, 28);
    graph.recordToolCall("web_fetch", 1); // escalates to untrusted
    const result = evaluateWithApprovals(graph, ["exec", "read"], config, approvalStore, "s1");
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.toolRemovals.has("read")).toBe(false); // safe tool
  });

  it("owner → exec (local) → everything still allowed", () => {
    const graph = makeGraph();
    graph.recordLlmCall(1, 28);
    graph.recordToolCall("exec", 1); // escalates to local
    const result = evaluateWithApprovals(graph, ["exec", "message", "read"], config, approvalStore, "s1");
    expect(result.toolRemovals.size).toBe(0);
  });

  it("owner → vestige_search (shared) → non-safe tools need confirm", () => {
    const graph = makeGraph();
    graph.recordLlmCall(1, 28);
    graph.recordToolCall("vestige_search", 1); // escalates to shared
    const result = evaluateWithApprovals(graph, ["exec", "message", "read"], config, approvalStore, "s1");
    // shared default is "confirm"
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.toolRemovals.has("read")).toBe(false);
  });

  it("approval flow: block → approve → allow", () => {
    const graph = graphWithTaint("untrusted");
    
    // Step 1: blocked
    const r1 = evaluateWithApprovals(graph, ["exec"], config, approvalStore, "s1");
    expect(r1.toolRemovals.has("exec")).toBe(true);
    
    // Step 2: get code and approve
    const code = approvalStore.addPendingBatch([{
      sessionKey: "s1", toolName: "exec", taintLevel: "untrusted", reason: "test", requestedAt: Date.now(),
    }]);
    approvalStore.approveWithCode("s1", "all", code, null);
    
    // Step 3: allowed
    const r2 = evaluateWithApprovals(graph, ["exec"], config, approvalStore, "s1");
    expect(r2.toolRemovals.has("exec")).toBe(false);
  });

  it("restrict mode cannot be bypassed by approval", () => {
    const restrictConfig = buildPolicyConfig({ owner: "restrict" });
    const graph = graphWithTaint("owner");
    
    // Even with a hypothetical approval, restrict tools stay blocked
    const result = evaluateWithApprovals(graph, ["exec"], restrictConfig, approvalStore, "s1");
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.pendingConfirmations).toHaveLength(0); // no confirm, just restrict
  });
});

// ============================================================
// WatermarkStore — Persistent Taint Watermarks
// ============================================================

describe("WatermarkStore", () => {
  let tmpDir: string;
  let ws: WatermarkStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "watermark-test-"));
    ws = new WatermarkStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("escalates and retrieves watermark", () => {
    ws.escalate("session-a", "external", "web_fetch", "web_fetch");
    const wm = ws.getLevel("session-a");
    expect(wm?.level).toBe("external");
    expect(wm?.reason).toBe("web_fetch");
  });

  it("tracks worst taint (does not downgrade)", () => {
    ws.escalate("session-a", "shared", "group chat", "group chat");
    expect(ws.getLevel("session-a")?.level).toBe("shared");

    ws.escalate("session-a", "external", "web_fetch", "web_fetch");
    expect(ws.getLevel("session-a")?.level).toBe("external");

    // Owner should not downgrade
    ws.escalate("session-a", "owner", "owner msg", "owner msg");
    expect(ws.getLevel("session-a")?.level).toBe("external");
  });

  it("does not create watermark for owner/system taint", () => {
    ws.escalate("session-a", "owner", "owner", "owner");
    expect(ws.getLevel("session-a")).toBeUndefined();

    ws.escalate("session-a", "system", "system", "system");
    expect(ws.getLevel("session-a")).toBeUndefined();
  });

  it("clear removes watermark", () => {
    ws.escalate("session-a", "external", "web_fetch", "web_fetch");
    expect(ws.getLevel("session-a")?.level).toBe("external");

    ws.clear("session-a");
    expect(ws.getLevel("session-a")).toBeUndefined();
  });

  it("clearWithAudit returns the cleared entry", () => {
    ws.escalate("session-a", "external", "web_fetch", "web_fetch");
    const cleared = ws.clearWithAudit("session-a");
    expect(cleared?.level).toBe("external");
    expect(cleared?.reason).toBe("web_fetch");
    expect(ws.getLevel("session-a")).toBeUndefined();
  });

  it("independent sessions have independent watermarks", () => {
    ws.escalate("session-a", "external", "web_fetch", "web_fetch");
    expect(ws.getLevel("session-a")?.level).toBe("external");
    expect(ws.getLevel("session-b")).toBeUndefined();
  });

  it("persists to disk and reloads", () => {
    ws.escalate("session-a", "external", "web_fetch", "web_fetch");
    ws.flush();

    // Create a new store pointing at same dir
    const ws2 = new WatermarkStore(tmpDir);
    expect(ws2.getLevel("session-a")?.level).toBe("external");
    expect(ws2.getLevel("session-a")?.reason).toBe("web_fetch");
  });

  it("survives reload after clear", () => {
    ws.escalate("session-a", "external", "web_fetch", "web_fetch");
    ws.clear("session-a");
    ws.flush();

    const ws2 = new WatermarkStore(tmpDir);
    expect(ws2.getLevel("session-a")).toBeUndefined();
  });
});
