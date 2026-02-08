import { strict as assert } from "node:assert";
import { evaluatePolicies, getToolRemovals, shouldBlockTurn, DEFAULT_POLICIES, type SecurityPolicy } from "../policy-engine.js";
import { TurnProvenanceGraph } from "../provenance-graph.js";

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

console.log("✅ policy-engine tests passed");
