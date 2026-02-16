/**
 * Security Policy Engine — Test Suite (4-Level Trust Model)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WatermarkStore } from "../watermark-store.js";
import { BlockedWriteStore } from "../blocked-write-store.js";
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
  const trustToTool: Record<string, string> = {
    trusted: "__skip__",
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
      trusted: "allow",
      shared: "confirm",
      external: "confirm",
      untrusted: "restrict",
    });
    expect(warnings).toHaveLength(0);
    expect(corrected.untrusted).toBe("restrict");
  });

  it("corrects non-monotonic config", () => {
    const { corrected, warnings } = validateMonotonicity({
      trusted: "confirm",
      shared: "allow", // less strict than trusted — should be corrected
      external: "confirm",
      untrusted: "confirm",
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(corrected.shared).toBe("confirm"); // corrected to match trusted
  });

  it("corrects untrusted being less strict than external", () => {
    const { corrected, warnings } = validateMonotonicity({
      trusted: "allow",
      shared: "allow",
      external: "restrict",
      untrusted: "allow", // less strict than external!
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(corrected.untrusted).toBe("restrict");
  });

  it("accepts all-allow", () => {
    const { corrected, warnings } = validateMonotonicity({
      trusted: "allow",
      shared: "allow",
      external: "allow",
      untrusted: "allow",
    });
    expect(warnings).toHaveLength(0);
  });

  it("accepts all-restrict", () => {
    const { corrected, warnings } = validateMonotonicity({
      trusted: "restrict",
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

  it("returns default mode for unoverridden tools at trusted level", () => {
    expect(getToolMode("exec", "trusted", config)).toBe("allow");
  });

  it("returns confirm for non-safe tools at external level", () => {
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

  it("returns 'allow' for gateway at all levels (safe tool)", () => {
    expect(getToolMode("gateway", "trusted", config)).toBe("allow");
    expect(getToolMode("gateway", "shared", config)).toBe("allow");
    expect(getToolMode("gateway", "external", config)).toBe("allow");
    expect(getToolMode("gateway", "untrusted", config)).toBe("allow");
  });

  it("user can override gateway to require confirm", () => {
    const configWithOverride = buildPolicyConfig(undefined, { "gateway": { "*": "confirm" } });
    expect(getToolMode("gateway", "trusted", configWithOverride)).toBe("confirm");
    expect(getToolMode("gateway", "shared", configWithOverride)).toBe("confirm");
  });

  it("override can make things more permissive (safe tools)", () => {
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
    expect(getToolMode("some_tool", "trusted", customConfig)).toBe("restrict");
    expect(getToolMode("some_tool", "untrusted", customConfig)).toBe("restrict");
  });

  it("is case-insensitive on tool name", () => {
    expect(getToolMode("Gateway", "shared", config)).toBe("allow");
    expect(getToolMode("GATEWAY", "untrusted", config)).toBe("allow");
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
    expect(config.taintPolicy.trusted).toBe("allow");
    expect(config.taintPolicy.shared).toBe("confirm");
    expect(config.taintPolicy.external).toBe("confirm");
    expect(config.taintPolicy.untrusted).toBe("confirm");
    expect(config.maxIterations).toBe(30);
  });

  it("merges user taint policy with defaults", () => {
    const config = buildPolicyConfig({ untrusted: "restrict" });
    expect(config.taintPolicy.trusted).toBe("allow");
    expect(config.taintPolicy.untrusted).toBe("restrict");
  });

  it("includes all safe tools", () => {
    const config = buildPolicyConfig();
    for (const tool of Object.keys(DEFAULT_SAFE_TOOLS)) {
      expect(config.toolOverrides[tool]).toBeDefined();
      expect(config.toolOverrides[tool]["*"]).toBe("allow");
    }
  });

  it("user overrides merge per-tool", () => {
    const config = buildPolicyConfig(undefined, {
      "gateway": { "trusted": "restrict" },
    });
    expect(config.toolOverrides["gateway"]["*"]).toBe("allow");       // from default (safe tool)
    expect(config.toolOverrides["gateway"]["trusted"]).toBe("restrict"); // from user
  });

  it("corrects non-monotonic taint policy", () => {
    const config = buildPolicyConfig({
      trusted: "confirm",
      shared: "allow", // invalid: less strict than trusted
    });
    expect(config.taintPolicy.shared).toBe("confirm"); // auto-corrected
  });

  it("maps legacy 6-level keys to 4-level", () => {
    const config = buildPolicyConfig({
      system: "allow",
      owner: "allow",
      local: "allow",
      shared: "confirm",
      external: "confirm",
      untrusted: "restrict",
    } as any);
    expect(config.taintPolicy.trusted).toBe("allow");
    expect(config.taintPolicy.shared).toBe("confirm");
    expect(config.taintPolicy.untrusted).toBe("restrict");
  });

  it("has no .owner, .system, or .local keys in taintPolicy", () => {
    const config = buildPolicyConfig();
    expect("owner" in config.taintPolicy).toBe(false);
    expect("system" in config.taintPolicy).toBe(false);
    expect("local" in config.taintPolicy).toBe(false);
  });
});

// ============================================================
// evaluatePolicy()
// ============================================================

describe("evaluatePolicy()", () => {
  const config = buildPolicyConfig();

  it("allows all tools at trusted taint", () => {
    const graph = graphWithTaint("trusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, config);
    expect(result.defaultMode).toBe("allow");
    expect(result.allowed).toContain("exec");
    expect(result.allowed).toContain("message");
    expect(result.allowed).toContain("gateway");
    expect(result.restricted).toHaveLength(0);
  });

  it("confirms dangerous tools and allows safe tools at untrusted taint", () => {
    const graph = graphWithTaint("untrusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, config);
    expect(result.defaultMode).toBe("confirm");
    expect(result.confirm.map(c => c.tool)).toContain("exec");
    expect(result.confirm.map(c => c.tool)).toContain("write");
    expect(result.allowed).toContain("read");
    expect(result.allowed).toContain("web_fetch");
    expect(result.allowed).toContain("memory_search");
    expect(result.allowed).toContain("gateway");
  });

  it("sets warning flag when max iterations exceeded (soft warning, no block)", () => {
    const config10 = buildPolicyConfig(undefined, undefined, 10);
    const graph = makeGraph();
    for (let i = 0; i < 11; i++) {
      graph.recordLlmCall(i, 28);
      graph.recordIterationEnd(i, 1, true);
    }
    const result = evaluatePolicy(graph, ALL_TOOLS, config10);
    expect(result.blockTurn).toBe(false);
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
      trusted: "restrict",
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    });
    const graph = graphWithTaint("trusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, restrictConfig);

    expect(result.allowed).toContain("read");
    expect(result.allowed).toContain("web_fetch");
    expect(result.allowed).toContain("memory_search");
    expect(result.restricted).toContain("exec");
    expect(result.restricted).toContain("write");
    expect(result.allowed).toContain("gateway");
  });

  it("all-allow mode allows everything including safe tools", () => {
    const allowConfig = buildPolicyConfig({
      trusted: "allow",
      shared: "allow",
      external: "allow",
      untrusted: "allow",
    });
    const graph = graphWithTaint("untrusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, allowConfig);
    expect(result.allowed).toContain("exec");
    expect(result.allowed).toContain("message");
    expect(result.allowed).toContain("gateway");
  });
});

// ============================================================
// evaluateWithApprovals()
// ============================================================

describe("evaluateWithApprovals()", () => {
  let approvalStore: ApprovalStore;
  const config = buildPolicyConfig();

  beforeEach(() => {
    approvalStore = new ApprovalStore();
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

    // First call to see it's blocked
    const result1 = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result1.toolRemovals.has("exec")).toBe(true);

    // Approve exec
    approvalStore.approve("session-1", "exec", null);

    // Second call should allow exec through
    const result2 = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result2.toolRemovals.has("exec")).toBe(false);
  });

  it("does not allow approval to bypass restrict mode", () => {
    const restrictConfig = buildPolicyConfig({
      trusted: "restrict",
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    });
    const graph = graphWithTaint("trusted");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, restrictConfig, approvalStore, "session-1");

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

  it("gateway always allowed (safe system tool)", () => {
    const graphShared = graphWithTaint("shared");
    const resultShared = evaluateWithApprovals(graphShared, ALL_TOOLS, config, approvalStore, "session-1");
    expect(resultShared.toolRemovals.has("gateway")).toBe(false);

    const graphUntrusted = graphWithTaint("untrusted");
    const resultUntrusted = evaluateWithApprovals(graphUntrusted, ALL_TOOLS, config, approvalStore, "session-2");
    expect(resultUntrusted.toolRemovals.has("gateway")).toBe(false);
  });

  it("reports effective mode based on most restrictive non-safe tool", () => {
    const graph = graphWithTaint("trusted");
    const result = evaluateWithApprovals(graph, ["gateway", "read", "exec"], config, approvalStore, "session-1");
    expect(result.mode).toBe("allow");
  });
});

// ============================================================
// ApprovalStore
// ============================================================

describe("ApprovalStore", () => {
  let store: ApprovalStore;

  beforeEach(() => {
    store = new ApprovalStore();
  });

  it("approves a tool for a session", () => {
    store.approve("s1", "exec");
    expect(store.isApproved("s1", "exec")).toBe(true);
  });

  it("is not approved before calling approve()", () => {
    expect(store.isApproved("s1", "exec")).toBe(false);
  });

  it("approves all tools with 'all' target", () => {
    store.approve("s1", "all");
    expect(store.isApproved("s1", "exec")).toBe(true);
    expect(store.isApproved("s1", "message")).toBe(true);
  });

  it("approveMultiple approves several tools at once", () => {
    store.approveMultiple("s1", ["exec", "message"]);
    expect(store.isApproved("s1", "exec")).toBe(true);
    expect(store.isApproved("s1", "message")).toBe(true);
    expect(store.isApproved("s1", "write")).toBe(false);
  });

  it("clears turn-scoped approvals", () => {
    store.approve("s1", "exec"); // null = turn-scoped
    expect(store.isApproved("s1", "exec")).toBe(true);
    store.clearTurnScoped("s1");
    expect(store.isApproved("s1", "exec")).toBe(false);
  });

  it("time-limited approvals survive turn clear", () => {
    store.approve("s1", "exec", 30); // 30 minutes
    expect(store.isApproved("s1", "exec")).toBe(true);
    store.clearTurnScoped("s1");
    expect(store.isApproved("s1", "exec")).toBe(true); // still approved
  });

  it("clearAll removes everything for a session", () => {
    store.approve("s1", "exec", 30);
    store.approve("s1", "write");
    store.clearAll("s1");
    expect(store.isApproved("s1", "exec")).toBe(false);
    expect(store.isApproved("s1", "write")).toBe(false);
  });

  it("listApprovals returns active entries", () => {
    store.approve("s1", "exec");
    store.approve("s1", "write", 30);
    const list = store.listApprovals("s1");
    expect(list).toHaveLength(2);
    expect(list.map(e => e.toolName)).toContain("exec");
    expect(list.map(e => e.toolName)).toContain("write");
  });

  it("listApprovals returns empty for unknown session", () => {
    expect(store.listApprovals("unknown")).toHaveLength(0);
  });

  it("independent sessions are isolated", () => {
    store.approve("s1", "exec");
    expect(store.isApproved("s1", "exec")).toBe(true);
    expect(store.isApproved("s2", "exec")).toBe(false);
  });
});

// ============================================================
// TurnProvenanceGraph
// ============================================================

describe("TurnProvenanceGraph", () => {
  it("starts at trusted taint", () => {
    const g = makeGraph();
    expect(g.maxTaint).toBe("trusted");
  });

  it("escalates taint on tool calls", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("exec", 1);
    expect(g.maxTaint).toBe("trusted"); // exec output is "trusted"
    g.recordToolCall("web_fetch", 1);
    expect(g.maxTaint).toBe("untrusted");
  });

  it("taint never decreases", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("web_fetch", 1); // untrusted
    g.recordToolCall("exec", 1);       // trusted — should not decrease taint
    expect(g.maxTaint).toBe("untrusted");
  });

  it("vestige tools escalate to shared", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("vestige_search", 1);
    expect(g.maxTaint).toBe("shared");
  });

  it("message escalates to external", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("message", 1);
    expect(g.maxTaint).toBe("external");
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
    approvalStore = new ApprovalStore();
  });

  it("trusted message → exec allowed, no restrictions", () => {
    const graph = graphWithTaint("trusted");
    const result = evaluateWithApprovals(graph, ["exec", "read"], config, approvalStore, "s1");
    expect(result.toolRemovals.has("exec")).toBe(false);
  });

  it("trusted → web_fetch → exec blocked (untrusted taint)", () => {
    const graph = makeGraph();
    graph.recordLlmCall(1, 28);
    graph.recordToolCall("web_fetch", 1); // escalates to untrusted
    const result = evaluateWithApprovals(graph, ["exec", "read"], config, approvalStore, "s1");
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.toolRemovals.has("read")).toBe(false); // safe tool
  });

  it("trusted → exec (trusted) → everything still allowed", () => {
    const graph = makeGraph();
    graph.recordLlmCall(1, 28);
    graph.recordToolCall("exec", 1); // exec output is trusted
    const result = evaluateWithApprovals(graph, ["exec", "message", "read"], config, approvalStore, "s1");
    expect(result.toolRemovals.size).toBe(0);
  });

  it("trusted → vestige_search (shared) → confirm mode for dangerous tools", () => {
    const graph = makeGraph();
    graph.recordLlmCall(1, 28);
    graph.recordToolCall("vestige_search", 1); // vestige output is "shared"
    const result = evaluateWithApprovals(graph, ["exec", "message", "read"], config, approvalStore, "s1");
    // shared default is "confirm" — exec and message need approval
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.toolRemovals.has("message")).toBe(true);
    expect(result.toolRemovals.has("read")).toBe(false);
  });

  it("approval flow: block → approve → allow", () => {
    const graph = graphWithTaint("untrusted");

    // Step 1: blocked
    const r1 = evaluateWithApprovals(graph, ["exec"], config, approvalStore, "s1");
    expect(r1.toolRemovals.has("exec")).toBe(true);

    // Step 2: approve
    approvalStore.approve("s1", "all", null);

    // Step 3: allowed
    const r2 = evaluateWithApprovals(graph, ["exec"], config, approvalStore, "s1");
    expect(r2.toolRemovals.has("exec")).toBe(false);
  });

  it("restrict mode cannot be bypassed by approval", () => {
    const restrictConfig = buildPolicyConfig({ trusted: "restrict" });
    const graph = graphWithTaint("trusted");

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

    // trusted should not downgrade
    ws.escalate("session-a", "trusted", "trusted msg", "trusted msg");
    expect(ws.getLevel("session-a")?.level).toBe("external");
  });

  it("does not create watermark for trusted taint", () => {
    ws.escalate("session-a", "trusted", "trusted", "trusted");
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

// ============================================================
// BlockedWriteStore
// ============================================================

describe("BlockedWriteStore", () => {
  let tmpDir: string;
  let bws: BlockedWriteStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "blocked-write-test-"));
    bws = new BlockedWriteStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and retrieves a blocked write", () => {
    const { id } = bws.save({
      targetPath: "MEMORY.md",
      content: "injected content",
      operation: "write",
      taintLevel: "untrusted",
      reason: "tainted context",
      blockedAt: new Date().toISOString(),
      sessionKey: "s1",
    });
    const entry = bws.get(id);
    expect(entry).toBeDefined();
    expect(entry!.targetPath).toBe("MEMORY.md");
    expect(entry!.content).toBe("injected content");
    expect(entry!.taintLevel).toBe("untrusted");
  });

  it("lists all blocked writes", () => {
    bws.save({
      targetPath: "MEMORY.md",
      content: "a",
      operation: "write",
      taintLevel: "untrusted",
      reason: "test",
      blockedAt: new Date().toISOString(),
      sessionKey: "s1",
    });
    bws.save({
      targetPath: "SOUL.md",
      content: "b",
      operation: "edit",
      oldText: "old",
      taintLevel: "external",
      reason: "test",
      blockedAt: new Date().toISOString(),
      sessionKey: "s1",
    });
    const list = bws.list();
    expect(list).toHaveLength(2);
  });

  it("removes a blocked write", () => {
    const { id } = bws.save({
      targetPath: "MEMORY.md",
      content: "x",
      operation: "write",
      taintLevel: "untrusted",
      reason: "test",
      blockedAt: new Date().toISOString(),
      sessionKey: "s1",
    });
    expect(bws.remove(id)).toBe(true);
    expect(bws.get(id)).toBeUndefined();
    expect(bws.remove(id)).toBe(false); // already removed
  });

  it("clearAll removes everything", () => {
    for (let i = 0; i < 3; i++) {
      bws.save({
        targetPath: `file-${i}.md`,
        content: `content-${i}`,
        operation: "write",
        taintLevel: "untrusted",
        reason: "test",
        blockedAt: new Date().toISOString(),
        sessionKey: "s1",
      });
    }
    expect(bws.list()).toHaveLength(3);
    const cleared = bws.clearAll();
    expect(cleared).toBe(3);
    expect(bws.list()).toHaveLength(0);
  });

  it("returns undefined for unknown ID", () => {
    expect(bws.get("nonexistent")).toBeUndefined();
  });
});
