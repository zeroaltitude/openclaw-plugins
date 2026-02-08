import { strict as assert } from "node:assert";
import { evaluatePolicies, getToolRemovals, shouldBlockTurn, evaluateTaintPolicy, evaluateTaintPolicyWithApprovals, DEFAULT_POLICIES, type SecurityPolicy } from "../policy-engine.js";
import { TurnProvenanceGraph } from "../provenance-graph.js";
import type { TaintPolicyConfig } from "../trust-levels.js";
import { DEFAULT_TAINT_POLICY } from "../trust-levels.js";
import { registerSecurityHooks } from "../index.js";
import { ApprovalStore } from "../approval-store.js";

// Helper to build a graph with specific taint
function graphWithTaint(toolName?: string): TurnProvenanceGraph {
  const g = new TurnProvenanceGraph("test");
  g.recordContextAssembled("prompt", 1);
  if (toolName) {
    const llmId = g.recordLlmCall(1, 5);
    g.recordToolCall(toolName, 1, llmId);
  }
  return g;
}

// contextTaintIncludes matches when taint is at or below specified level
{
  const policy: SecurityPolicy = {
    name: "test",
    when: { contextTaintIncludes: ["external"] },
    action: { removeTools: ["exec"] },
  };
  
  // Graph with only owner taint (idx 1) — "external" (idx 4) not reached
  const cleanGraph = graphWithTaint(); // owner taint from history
  const evals1 = evaluatePolicies([policy], cleanGraph);
  assert.equal(evals1[0].matched, false);
  
  // Graph with external taint
  const taintedGraph = graphWithTaint("message"); // external trust
  const evals2 = evaluatePolicies([policy], taintedGraph);
  assert.equal(evals2[0].matched, true);
  
  // Graph with untrusted taint (worse than external) — should also match
  const untrustedGraph = graphWithTaint("web_fetch");
  const evals3 = evaluatePolicies([policy], untrustedGraph);
  assert.equal(evals3[0].matched, true);
}

// iterationGte condition
{
  const policy: SecurityPolicy = {
    name: "max-iter",
    when: { iterationGte: 5 },
    action: { blockTurn: true, reason: "too many iterations" },
  };
  
  const g = new TurnProvenanceGraph("test");
  g.recordContextAssembled("prompt", 0);
  
  // iteration 1 — no match
  g.recordLlmCall(1, 5);
  let evals = evaluatePolicies([policy], g);
  assert.equal(evals[0].matched, false);
  
  // iteration 5 — match
  g.recordLlmCall(5, 5);
  evals = evaluatePolicies([policy], g);
  assert.equal(evals[0].matched, true);
}

// toolsUsed condition
{
  const policy: SecurityPolicy = {
    name: "after-web",
    when: { toolsUsed: ["web_fetch"] },
    action: { removeTools: ["exec"] },
  };
  
  const g = new TurnProvenanceGraph("test");
  g.recordContextAssembled("prompt", 0);
  const llmId = g.recordLlmCall(1, 5);
  
  // No web_fetch yet
  let evals = evaluatePolicies([policy], g);
  assert.equal(evals[0].matched, false);
  
  // After web_fetch
  g.recordToolCall("web_fetch", 1, llmId);
  evals = evaluatePolicies([policy], g);
  assert.equal(evals[0].matched, true);
}

// getToolRemovals collects from matched policies
{
  const evals = [
    { policy: { name: "p1", when: {}, action: { removeTools: ["exec"] } }, matched: true, action: { removeTools: ["exec"] } },
    { policy: { name: "p2", when: {}, action: { blockTools: ["message"] } }, matched: true, action: { blockTools: ["message"] } },
    { policy: { name: "p3", when: {}, action: { removeTools: ["browser"] } }, matched: false, action: undefined },
  ];
  const removals = getToolRemovals(evals);
  assert.ok(removals.has("exec"));
  assert.ok(removals.has("message"));
  assert.ok(!removals.has("browser")); // not matched
}

// shouldBlockTurn
{
  const evals = [
    { policy: { name: "p1", when: {}, action: { removeTools: ["exec"] } }, matched: true, action: { removeTools: ["exec"] } },
    { policy: { name: "p2", when: {}, action: { blockTurn: true, reason: "blocked!" } }, matched: true, action: { blockTurn: true, reason: "blocked!" } },
  ];
  const result = shouldBlockTurn(evals);
  assert.equal(result.block, true);
  assert.equal(result.reason, "blocked!");
}

// shouldBlockTurn returns false when no block
{
  const evals = [
    { policy: { name: "p1", when: {}, action: { removeTools: ["exec"] } }, matched: true, action: { removeTools: ["exec"] } },
  ];
  const result = shouldBlockTurn(evals);
  assert.equal(result.block, false);
}

// DEFAULT_POLICIES: no-exec-when-external
{
  const g = graphWithTaint("message"); // external
  const evals = evaluatePolicies(DEFAULT_POLICIES, g);
  const removals = getToolRemovals(evals);
  assert.ok(removals.has("exec"), "exec should be removed when external content present");
}

// DEFAULT_POLICIES: no-send-when-untrusted
{
  const g = graphWithTaint("web_fetch"); // untrusted
  const evals = evaluatePolicies(DEFAULT_POLICIES, g);
  const removals = getToolRemovals(evals);
  assert.ok(removals.has("message"), "message should be blocked when untrusted content present");
  assert.ok(removals.has("exec"), "exec should also be removed (external includes untrusted)");
}

// DEFAULT_POLICIES: max-recursion
{
  const g = new TurnProvenanceGraph("test");
  g.recordContextAssembled("prompt", 0);
  g.recordLlmCall(10, 5);
  const evals = evaluatePolicies(DEFAULT_POLICIES, g);
  const block = shouldBlockTurn(evals);
  assert.equal(block.block, true);
}

// evaluateTaintPolicy: default policy — owner taint is "allow"
{
  const g = graphWithTaint(); // owner taint
  const result = evaluateTaintPolicy(g);
  assert.equal(result.mode, "allow");
  assert.equal(result.level, "owner");
}

// evaluateTaintPolicy: default policy — external taint is "restrict"
{
  const g = graphWithTaint("message"); // external taint
  const result = evaluateTaintPolicy(g);
  assert.equal(result.mode, "restrict");
  assert.equal(result.level, "external");
}

// evaluateTaintPolicy: default policy — untrusted taint is "restrict"
{
  const g = graphWithTaint("web_fetch"); // untrusted taint
  const result = evaluateTaintPolicy(g);
  assert.equal(result.mode, "restrict");
  assert.equal(result.level, "untrusted");
}

// evaluateTaintPolicy: custom "allow" mode skips policy evaluation
{
  const g = graphWithTaint("web_fetch"); // untrusted taint
  const policy: TaintPolicyConfig = { untrusted: "allow" };
  const result = evaluateTaintPolicy(g, policy);
  assert.equal(result.mode, "allow");
}

// evaluateTaintPolicy: custom "deny" mode blocks the turn
{
  const g = graphWithTaint("message"); // external taint
  const policy: TaintPolicyConfig = { external: "deny" };
  const result = evaluateTaintPolicy(g, policy);
  assert.equal(result.mode, "deny");
  assert.equal(result.level, "external");
}

// evaluateTaintPolicy: "restrict" mode applies normal policies
{
  const g = graphWithTaint("message"); // external taint
  const policy: TaintPolicyConfig = { external: "restrict" };
  const result = evaluateTaintPolicy(g, policy);
  assert.equal(result.mode, "restrict");
}

// Integration: registerSecurityHooks with taint policy
// Test that "allow" mode returns no tool removals via the hook
{
  
  const logs: string[] = [];
  const mockLogger = {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push(args.join(" ")),
  };
  const hooks = new Map<string, Function>();
  const mockApi = {
    registerHook: (event: string, handler: Function, _opts?: any) => {
      hooks.set(event, handler);
    },
  };

  // Register with taint policy that allows untrusted
  registerSecurityHooks(mockApi, mockLogger, {
    taintPolicy: { untrusted: "allow", external: "allow" },
  });

  // Simulate context_assembled
  hooks.get("context_assembled")!({ systemPrompt: "test", messageCount: 5 }, { sessionKey: "test-session" });

  // Simulate before_llm_call with untrusted taint
  // First add an untrusted tool call to taint the graph
  hooks.get("after_llm_call")!({ toolCalls: [{ name: "web_fetch" }], iteration: 0 }, { sessionKey: "test-session" });

  // Now the graph has untrusted taint — with allow policy, should return undefined
  const result = hooks.get("before_llm_call")!({ iteration: 1, tools: [{ name: "exec" }, { name: "message" }] }, { sessionKey: "test-session" });
  assert.equal(result, undefined, "allow mode should not restrict tools");

  // Verify logging mentions "allow"
  assert.ok(logs.some(l => l.includes("allow")), "should log allow policy");
}

// Integration: taint policy "deny" blocks via the hook
{
  
  const logs: string[] = [];
  const mockLogger = {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push(args.join(" ")),
  };
  const hooks = new Map<string, Function>();
  const mockApi = {
    registerHook: (event: string, handler: Function, _opts?: any) => {
      hooks.set(event, handler);
    },
  };

  registerSecurityHooks(mockApi, mockLogger, {
    taintPolicy: { external: "deny" },
  });

  hooks.get("context_assembled")!({ systemPrompt: "test", messageCount: 5 }, { sessionKey: "deny-test" });
  hooks.get("after_llm_call")!({ toolCalls: [{ name: "message" }], iteration: 0 }, { sessionKey: "deny-test" });

  const result = hooks.get("before_llm_call")!({ iteration: 1, tools: [{ name: "exec" }] }, { sessionKey: "deny-test" });
  assert.ok(result?.block, "deny mode should block the turn");
  assert.ok(result?.blockReason?.includes("denied"), "should mention denied");
}

// Debug logging: verify format
{
  
  const logs: string[] = [];
  const mockLogger = {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push(args.join(" ")),
  };
  const hooks = new Map<string, Function>();
  const mockApi = {
    registerHook: (event: string, handler: Function, _opts?: any) => {
      hooks.set(event, handler);
    },
  };

  registerSecurityHooks(mockApi, mockLogger);

  // context_assembled
  hooks.get("context_assembled")!({ systemPrompt: "hello world", messageCount: 42 }, { sessionKey: "agent:main:log-test" });
  assert.ok(logs.some(l => l.includes("Turn Start")), "should log Turn Start");
  assert.ok(logs.some(l => l.includes("Messages: 42")), "should log message count");
  assert.ok(logs.some(l => l.includes("11 chars")), "should log system prompt length");

  // before_llm_call
  hooks.get("before_llm_call")!({ iteration: 0, tools: [{ name: "Read" }, { name: "exec" }] }, { sessionKey: "agent:main:log-test" });
  assert.ok(logs.some(l => l.includes("LLM Call (iteration 0)")), "should log LLM Call");

  // after_llm_call
  hooks.get("after_llm_call")!({ toolCalls: [{ name: "Read" }], iteration: 0 }, { sessionKey: "agent:main:log-test" });
  assert.ok(logs.some(l => l.includes("LLM Response")), "should log LLM Response");
  assert.ok(logs.some(l => l.includes("Read(local)")), "should log tool trust");

  // loop_iteration_end
  hooks.get("loop_iteration_end")!({ iteration: 0, toolCallsMade: 1, willContinue: true }, { sessionKey: "agent:main:log-test" });
  assert.ok(logs.some(l => l.includes("Iteration 0 End")), "should log Iteration End");

  // before_response_emit
  hooks.get("before_response_emit")!({ content: "response text" }, { sessionKey: "agent:main:log-test" });
  assert.ok(logs.some(l => l.includes("Turn Complete")), "should log Turn Complete");
  assert.ok(logs.some(l => l.includes("Final taint")), "should log final taint");
  assert.ok(logs.some(l => l.includes("Graph:")), "should log graph JSON dump");
}

// --- evaluateTaintPolicyWithApprovals tests ---

// "confirm" mode with no approvals → tools restricted + pendingConfirmations populated
{
  const g = graphWithTaint("message"); // external taint
  const config = { ...DEFAULT_TAINT_POLICY, external: "confirm" as const };
  const store = new ApprovalStore();
  const result = evaluateTaintPolicyWithApprovals(g, config, DEFAULT_POLICIES, store, "test-session");
  assert.equal(result.mode, "confirm");
  assert.ok(result.toolRemovals.has("exec"), "exec should be restricted");
  assert.ok(result.pendingConfirmations.length > 0, "should have pending confirmations");
  assert.ok(result.pendingConfirmations.some(p => p.toolName === "exec"));
}

// "confirm" mode with approval → approved tool not in removals
{
  const g = graphWithTaint("message"); // external taint
  const config = { ...DEFAULT_TAINT_POLICY, external: "confirm" as const };
  const store = new ApprovalStore();
  store.approve("test-session", "exec");
  const result = evaluateTaintPolicyWithApprovals(g, config, DEFAULT_POLICIES, store, "test-session");
  assert.equal(result.mode, "confirm");
  assert.ok(!result.toolRemovals.has("exec"), "exec should NOT be restricted after approval");
  assert.ok(!result.pendingConfirmations.some(p => p.toolName === "exec"));
}

// "confirm" mode with approveAll → no removals
{
  const g = graphWithTaint("web_fetch"); // untrusted taint
  const config = { ...DEFAULT_TAINT_POLICY, untrusted: "confirm" as const };
  const store = new ApprovalStore();
  store.addPending({ sessionKey: "s1", toolName: "exec", taintLevel: "untrusted", reason: "test", requestedAt: 1 });
  store.addPending({ sessionKey: "s1", toolName: "message", taintLevel: "untrusted", reason: "test", requestedAt: 2 });
  store.approveAll("s1");
  const result = evaluateTaintPolicyWithApprovals(g, config, DEFAULT_POLICIES, store, "s1");
  assert.equal(result.mode, "confirm");
  assert.equal(result.toolRemovals.size, 0, "no removals after approveAll");
  assert.equal(result.pendingConfirmations.length, 0);
}

// "allow" mode → no removals regardless
{
  const g = graphWithTaint("web_fetch"); // untrusted taint
  const config = { ...DEFAULT_TAINT_POLICY, untrusted: "allow" as const };
  const store = new ApprovalStore();
  const result = evaluateTaintPolicyWithApprovals(g, config, DEFAULT_POLICIES, store, "s1");
  assert.equal(result.mode, "allow");
  assert.equal(result.toolRemovals.size, 0);
}

// "deny" mode → block=true
{
  const g = graphWithTaint("message"); // external taint
  const config = { ...DEFAULT_TAINT_POLICY, external: "deny" as const };
  const store = new ApprovalStore();
  const result = evaluateTaintPolicyWithApprovals(g, config, DEFAULT_POLICIES, store, "s1");
  assert.equal(result.mode, "deny");
  assert.equal(result.block, true);
  assert.ok(result.blockReason?.includes("denied"));
}

// Integration: confirm mode with !approve in before_llm_call
{
  const logs: string[] = [];
  const mockLogger = {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push(args.join(" ")),
  };
  const hooks = new Map<string, Function>();
  const mockApi = {
    registerHook: (event: string, handler: Function, _opts?: any) => {
      hooks.set(event, handler);
    },
  };

  registerSecurityHooks(mockApi, mockLogger, {
    taintPolicy: { external: "confirm" },
  });

  // Setup: create graph with external taint
  hooks.get("context_assembled")!({ systemPrompt: "test", messageCount: 5 }, { sessionKey: "confirm-test" });
  hooks.get("after_llm_call")!({ toolCalls: [{ name: "message" }], iteration: 0 }, { sessionKey: "confirm-test" });

  // First call: tools should be restricted with pending confirmations
  const result1 = hooks.get("before_llm_call")!({
    iteration: 1,
    tools: [{ name: "exec" }, { name: "Read" }],
    messages: [{ role: "user", content: "run a command" }],
  }, { sessionKey: "confirm-test" });
  assert.ok(result1?.tools, "should return filtered tools");
  assert.ok(!result1.tools.some((t: any) => t.name === "exec"), "exec should be removed");
  assert.ok(logs.some(l => l.includes("⚠️ SECURITY")), "should log security warning");

  // Second call: user approves exec
  const result2 = hooks.get("before_llm_call")!({
    iteration: 2,
    tools: [{ name: "exec" }, { name: "Read" }],
    messages: [{ role: "user", content: "!approve exec" }],
  }, { sessionKey: "confirm-test" });
  // exec should now be allowed
  if (result2?.tools) {
    assert.ok(result2.tools.some((t: any) => t.name === "exec"), "exec should be allowed after approval");
  }
  // If result2 is undefined, that means no tools were removed — also correct
  assert.ok(logs.some(l => l.includes("✅") && l.includes("exec")), "should log approval");
}

console.log("✅ policy-engine tests passed");
