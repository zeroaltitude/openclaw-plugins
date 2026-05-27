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
  DEFAULT_TOOL_EXECUTION_POLICY,
  type PolicyMode,
  type PolicyConfig,
} from "../policy-engine.js";
import { TurnProvenanceGraph } from "../provenance-graph.js";
import { ApprovalStore } from "../approval-store.js";
import { DEFAULT_TOOL_OUTPUT_TAINTS, type TrustLevel } from "../trust-levels.js";

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
  "exec", "bash", "read", "write", "edit", "browser", "message", "gateway",
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
    expect(strictest("allow", "restrict")).toBe("restrict");
    expect(strictest("restrict", "allow")).toBe("restrict");
    expect(strictest("allow", "allow")).toBe("allow");
  });

  it("is commutative", () => {
    expect(strictest("allow", "restrict")).toBe(strictest("restrict", "allow"));
    expect(strictest("restrict", "allow")).toBe(strictest("allow", "restrict"));
  });

  it("is idempotent", () => {
    expect(strictest("allow", "allow")).toBe("allow");
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
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    });
    expect(warnings).toHaveLength(0);
    expect(corrected.untrusted).toBe("restrict");
  });

  it("corrects non-monotonic config", () => {
    const { corrected, warnings } = validateMonotonicity({
      trusted: "restrict",
      shared: "allow", // less strict than trusted — should be corrected
      external: "restrict",
      untrusted: "restrict",
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(corrected.shared).toBe("restrict"); // corrected to match trusted
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

  it("returns restrict for non-safe tools at external level", () => {
    expect(getToolMode("exec", "external", config)).toBe("restrict");
  });

  it("returns 'allow' for safe tools even at untrusted", () => {
    expect(getToolMode("read", "untrusted", config)).toBe("allow");
    // web_fetch/web_search/image/vestige_*/sessions_history are restricted at untrusted
    // to prevent 2nd-stage payload fetches, memory extraction, and cross-session data leaks.
    expect(getToolMode("web_fetch", "untrusted", config)).toBe("restrict");
    // memory_search is restricted at shared+ taint (protects memory from tainted queries)
    expect(getToolMode("memory_search", "untrusted", config)).toBe("restrict");
    expect(getToolMode("vestige_search", "untrusted", config)).toBe("restrict");
    expect(getToolMode("image", "untrusted", config)).toBe("restrict");
    expect(getToolMode("session_status", "untrusted", config)).toBe("allow");
  });

  it("returns 'allow' for gateway except at untrusted (restricted there)", () => {
    expect(getToolMode("gateway", "trusted", config)).toBe("allow");
    expect(getToolMode("gateway", "shared", config)).toBe("allow");
    expect(getToolMode("gateway", "external", config)).toBe("allow");
    expect(getToolMode("gateway", "untrusted", config)).toBe("restrict");
  });

  it("user can override gateway to allow", () => {
    const configWithOverride = buildPolicyConfig(undefined, { "gateway": { "*": "allow" } });
    expect(getToolMode("gateway", "trusted", configWithOverride)).toBe("allow");
    expect(getToolMode("gateway", "shared", configWithOverride)).toBe("allow");
  });

  it("override can make things more permissive (safe tools)", () => {
    const customConfig = buildPolicyConfig(
      { external: "restrict" },
      { "exec": { "external": "allow" } },
    );
    expect(getToolMode("exec", "external", customConfig)).toBe("allow");
  });

  it("override can make things stricter", () => {
    const customConfig = buildPolicyConfig(
      { external: "allow" },
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
    expect(getToolMode("GATEWAY", "untrusted", config)).toBe("restrict");
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
    expect(config.taintPolicy.shared).toBe("restrict");
    expect(config.taintPolicy.external).toBe("restrict");
    expect(config.taintPolicy.untrusted).toBe("restrict");
    expect(config.maxIterations).toBe(30);
  });

  it("merges user taint policy with defaults", () => {
    const config = buildPolicyConfig({ untrusted: "restrict" });
    expect(config.taintPolicy.trusted).toBe("allow");
    expect(config.taintPolicy.untrusted).toBe("restrict");
  });

  it("all tools in DEFAULT_TOOL_EXECUTION_POLICY are present in built config", () => {
    const config = buildPolicyConfig();
    for (const tool of Object.keys(DEFAULT_TOOL_EXECUTION_POLICY)) {
      expect(config.toolOverrides[tool]).toBeDefined();
    }
  });

  it("keeps heartbeat_respond trusted and allowed at tainted levels", () => {
    const config = buildPolicyConfig();
    const graph = graphWithTaint("untrusted");
    const approvals = new ApprovalStore();

    expect(DEFAULT_TOOL_OUTPUT_TAINTS.heartbeat_respond).toBe("trusted");
    expect(config.toolOverrides.heartbeat_respond["*"]).toBe("allow");

    const result = evaluateWithApprovals(
      graph,
      ["heartbeat_respond"],
      config,
      approvals,
      "heartbeat-session",
    );
    expect(result.toolRemovals.has("heartbeat_respond")).toBe(false);
    expect(result.pendingConfirmations).toHaveLength(0);
  });

  it("user overrides merge per-tool", () => {
    const config = buildPolicyConfig(undefined, {
      "gateway": { "trusted": "restrict" },
    });
    // gateway's default per-level keys survive the merge...
    expect(config.toolOverrides["gateway"]["untrusted"]).toBe("restrict"); // from default
    expect(config.toolOverrides["gateway"]["shared"]).toBe("allow");       // from default
    // ...and the user's per-level override wins where it overlaps.
    expect(config.toolOverrides["gateway"]["trusted"]).toBe("restrict");   // from user (was "allow")
  });

  it("corrects non-monotonic taint policy", () => {
    const config = buildPolicyConfig({
      trusted: "restrict",
      shared: "allow", // invalid: less strict than trusted
    });
    expect(config.taintPolicy.shared).toBe("restrict"); // auto-corrected to match trusted
  });

  it("maps legacy 6-level keys to 4-level (and legacy confirm → restrict)", () => {
    const config = buildPolicyConfig({
      system: "allow",
      owner: "allow",
      local: "allow",
      shared: "confirm",   // legacy mode — normalizes to "restrict"
      external: "confirm", // legacy mode — normalizes to "restrict"
      untrusted: "restrict",
    } as any);
    expect(config.taintPolicy.trusted).toBe("allow");
    expect(config.taintPolicy.shared).toBe("restrict");
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

  it("allows all tools at trusted taint, including gateway", () => {
    const graph = graphWithTaint("trusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, config);
    expect(result.defaultMode).toBe("allow");
    expect(result.allowed).toContain("exec");
    expect(result.allowed).toContain("message");
    // gateway is now allowed at trusted/shared/external (restrict only at untrusted)
    expect(result.allowed).toContain("gateway");
    expect(result.restricted).toHaveLength(0);
  });

  it("restricts shell/file tools and gateway at untrusted taint", () => {
    const graph = graphWithTaint("untrusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, config);
    // Two-mode model: untrusted taint-policy default is "restrict".
    expect(result.defaultMode).toBe("restrict");
    // exec/bash/write/edit are restricted at untrusted — owner-overridable via /approve-exec.
    expect(result.restricted).toContain("exec");
    expect(result.restricted).toContain("bash");
    expect(result.restricted).toContain("write");
    // gateway is restricted at untrusted (allowed at every other level)
    expect(result.restricted).toContain("gateway");
    expect(result.allowed).toContain("read");
    // web_fetch is restricted at untrusted (prevent 2nd-stage payload fetches)
    expect(result.restricted).toContain("web_fetch");
    // memory_search is restricted at shared+ taint (protects memory from tainted queries)
    expect(result.restricted).toContain("memory_search");
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
    // Note: exec/bash/write have per-tool overrides (trusted: "allow") that win over the
    // taint-policy default. Per-tool overrides are intentional escape hatches — they beat
    // the taint policy by design. A truly locked-down config should set explicit
    // toolOverrides: { exec: { "*": "restrict" } }.
    expect(result.allowed).toContain("exec");
    expect(result.allowed).toContain("write");
    // gateway is allowed at trusted (its per-tool override beats the all-restrict policy)
    expect(result.allowed).toContain("gateway");
  });

  it("all-allow mode: per-tool restrict overrides still win at untrusted", () => {
    const allowConfig = buildPolicyConfig({
      trusted: "allow",
      shared: "allow",
      external: "allow",
      untrusted: "allow",
    });
    const graph = graphWithTaint("untrusted");
    const result = evaluatePolicy(graph, ALL_TOOLS, allowConfig);
    // Note: exec/bash/write/message/browser/cron/gateway etc. have per-tool overrides
    // (untrusted: "restrict") that win over the all-allow taint policy. This is intentional
    // — prompt-injection protection for shell/file/messaging tools is a hard default,
    // not overridable by taint policy alone.
    // To truly allow these under untrusted, pass explicit toolOverrides: { exec: { "*": "allow" } }.
    expect(result.restricted).toContain("exec");
    expect(result.restricted).toContain("message");
    expect(result.restricted).toContain("gateway");
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
    // In the two-mode model, restricted tools are removed AND listed as approvable.
    expect(result.toolRemovals.has("exec")).toBe(true);
    expect(result.pendingConfirmations.map(p => p.toolName)).toContain("exec");
    // canvas/tts/nodes follow taint-policy default ("restrict" at untrusted) — also approvable
    expect(result.toolRemovals.has("canvas")).toBe(true);
    expect(result.pendingConfirmations.map(p => p.toolName)).toContain("canvas");
  });

  it("approval unblocks a restricted tool (restrict is owner-overridable)", () => {
    const graph = graphWithTaint("untrusted");

    // exec is restricted at untrusted — removed before approval
    const result1 = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result1.toolRemovals.has("exec")).toBe(true);

    // Owner approves exec for the session
    approvalStore.approve("session-1", "exec", null);

    // exec now passes through (restrict + approval = allowed)
    const result2 = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result2.toolRemovals.has("exec")).toBe(false);
  });

  it("restricted tools are removed but approvable", () => {
    const restrictConfig = buildPolicyConfig({
      trusted: "restrict",
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    });
    const graph = graphWithTaint("trusted");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, restrictConfig, approvalStore, "session-1");

    // canvas/tts/nodes follow taint-policy default (no per-tool override at trusted level) →
    // restricted in all-restrict config. They are removed AND listed as approvable.
    expect(result.toolRemovals.has("canvas")).toBe(true);
    expect(result.pendingConfirmations.map(p => p.toolName)).toContain("canvas");

    // And approval clears them
    approvalStore.approve("session-1", "canvas", null);
    const result2 = evaluateWithApprovals(graph, ALL_TOOLS, restrictConfig, approvalStore, "session-1");
    expect(result2.toolRemovals.has("canvas")).toBe(false);
  });

  it("safe tools pass through even at untrusted", () => {
    const graph = graphWithTaint("untrusted");
    const result = evaluateWithApprovals(graph, ALL_TOOLS, config, approvalStore, "session-1");
    expect(result.toolRemovals.has("read")).toBe(false);
    expect(result.toolRemovals.has("session_status")).toBe(false);
    // web_fetch is now restricted at untrusted (prevent 2nd-stage payload fetches)
    expect(result.toolRemovals.has("web_fetch")).toBe(true);
    // memory_search is restricted at shared+ taint (protects memory from tainted queries)
    expect(result.toolRemovals.has("memory_search")).toBe(true);
  });

  it("gateway is allowed except at untrusted, where it is restricted (approvable)", () => {
    // gateway: allow at trusted/shared/external, restrict at untrusted
    const graphShared = graphWithTaint("shared");
    const resultShared = evaluateWithApprovals(graphShared, ALL_TOOLS, config, approvalStore, "session-1");
    expect(resultShared.toolRemovals.has("gateway")).toBe(false);

    const graphExternal = graphWithTaint("external");
    const resultExternal = evaluateWithApprovals(graphExternal, ALL_TOOLS, config, approvalStore, "session-ext");
    expect(resultExternal.toolRemovals.has("gateway")).toBe(false);

    const graphUntrusted = graphWithTaint("untrusted");
    const resultUntrusted = evaluateWithApprovals(graphUntrusted, ALL_TOOLS, config, approvalStore, "session-2");
    expect(resultUntrusted.toolRemovals.has("gateway")).toBe(true);

    const graphTrusted = graphWithTaint("trusted");
    const resultTrusted = evaluateWithApprovals(graphTrusted, ALL_TOOLS, config, approvalStore, "session-3");
    expect(resultTrusted.toolRemovals.has("gateway")).toBe(false);
  });

  it("gateway can be approved by owner at untrusted", () => {
    const graph = graphWithTaint("untrusted");
    approvalStore.approve("session-1", "gateway", null);
    const result = evaluateWithApprovals(graph, ["gateway", "read"], config, approvalStore, "session-1");
    expect(result.toolRemovals.has("gateway")).toBe(false);
  });

  it("reports effective mode based on most restrictive tool", () => {
    // At untrusted, exec is restricted → effective mode is restrict
    const graph = graphWithTaint("untrusted");
    const result = evaluateWithApprovals(graph, ["read", "exec"], config, approvalStore, "session-1");
    expect(result.mode).toBe("restrict");
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

  it("vestige tools stay trusted (local cognitive memory)", () => {
    const g = makeGraph();
    g.recordLlmCall(1, 28);
    g.recordToolCall("vestige_search", 1);
    expect(g.maxTaint).toBe("trusted");
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

  it("trusted → shared taint → confirm mode for taint-default tools", () => {
    const graph = makeGraph();
    graph.recordLlmCall(1, 28);
    // Use effectiveTrust override to simulate a tool that produces "shared" taint
    graph.recordToolCall("some_shared_tool", 1, undefined, undefined, { effectiveTrust: "shared" });
    const result = evaluateWithApprovals(graph, ["exec", "canvas", "read"], config, approvalStore, "s1");
    // shared default is "confirm" — canvas (no per-level override at shared) needs approval
    // exec has an explicit per-tool override: shared → "allow", so it passes through freely
    expect(result.toolRemovals.has("exec")).toBe(false);
    expect(result.toolRemovals.has("canvas")).toBe(true);
    expect(result.toolRemovals.has("read")).toBe(false);
  });

  it("approval flow: block → approve → allow (for confirm-level tools)", () => {
    const graph = graphWithTaint("untrusted");

    // canvas/tts/nodes follow the taint-policy default at untrusted ("confirm"), so they're approvable
    // (unlike exec/bash/write/message which are hard-restricted and cannot be approved at untrusted)

    // Step 1: blocked — canvas is removed pending confirmation
    const r1 = evaluateWithApprovals(graph, ["canvas"], config, approvalStore, "s1");
    expect(r1.toolRemovals.has("canvas")).toBe(true);
    expect(r1.pendingConfirmations.map(p => p.toolName)).toContain("canvas");

    // Step 2: approve
    approvalStore.approve("s1", "all", null);

    // Step 3: allowed after approval
    const r2 = evaluateWithApprovals(graph, ["canvas"], config, approvalStore, "s1");
    expect(r2.toolRemovals.has("canvas")).toBe(false);
  });

  it("restrict mode IS bypassable by approval (unified two-mode model)", () => {
    // In the two-mode model, restrict is the single approvable gate — the old
    // "restrict cannot be approved" invariant was removed when confirm was folded in.
    const restrictConfig = buildPolicyConfig({ trusted: "restrict" });
    const graph = graphWithTaint("trusted");

    // Without approval: canvas (taint-default → restrict here) is removed and approvable.
    const before = evaluateWithApprovals(graph, ["canvas"], restrictConfig, approvalStore, "s1");
    expect(before.toolRemovals.has("canvas")).toBe(true);
    expect(before.pendingConfirmations.map(p => p.toolName)).toContain("canvas");

    // With approval: it passes through.
    approvalStore.approve("s1", "canvas", null);
    const after = evaluateWithApprovals(graph, ["canvas"], restrictConfig, approvalStore, "s1");
    expect(after.toolRemovals.has("canvas")).toBe(false);
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
