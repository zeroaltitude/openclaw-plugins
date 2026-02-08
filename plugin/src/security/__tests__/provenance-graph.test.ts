import { strict as assert } from "node:assert";
import { TurnProvenanceGraph, ProvenanceStore } from "../provenance-graph.js";

// --- TurnProvenanceGraph ---

// Basic node/edge creation
{
  const g = new TurnProvenanceGraph("sess1", "test-turn-1");
  assert.equal(g.sessionKey, "sess1");
  assert.equal(g.turnId, "test-turn-1");
  assert.equal(g.maxTaint, "system"); // starts at highest trust
  assert.equal(g.sealed, false);
}

// Context assembly with history
{
  const g = new TurnProvenanceGraph("sess1");
  g.recordContextAssembled("You are helpful", 5);
  assert.equal(g.getAllNodes().length, 2); // system_prompt + history
  assert.equal(g.maxTaint, "owner"); // history node has "owner" trust
}

// Context assembly without history
{
  const g = new TurnProvenanceGraph("sess1");
  g.recordContextAssembled("You are helpful", 0);
  assert.equal(g.getAllNodes().length, 1); // only system_prompt
  assert.equal(g.maxTaint, "system");
}

// Taint propagation through tool calls
{
  const g = new TurnProvenanceGraph("sess1");
  g.recordContextAssembled("prompt", 1);
  assert.equal(g.maxTaint, "owner");
  
  const llmId = g.recordLlmCall(1, 5);
  assert.equal(g.maxTaint, "owner"); // LLM inherits current taint
  
  g.recordToolCall("Read", 1, llmId); // local trust (idx 2) > owner (idx 1), so taint becomes "local"
  assert.equal(g.maxTaint, "local");
  
  g.recordToolCall("web_fetch", 1, llmId); // untrusted
  assert.equal(g.maxTaint, "untrusted");
}

// External sources tracking
{
  const g = new TurnProvenanceGraph("sess1");
  g.recordContextAssembled("prompt", 0);
  const llmId = g.recordLlmCall(1, 5);
  g.recordToolCall("Read", 1, llmId);
  g.recordToolCall("web_fetch", 1, llmId);
  g.recordToolCall("message", 1, llmId);
  
  const summary = g.summary();
  assert.deepEqual(summary.toolsUsed, ["Read", "web_fetch", "message"]);
  assert.deepEqual(summary.externalSources, ["web_fetch", "message"]);
}

// Edges created
{
  const g = new TurnProvenanceGraph("sess1");
  g.recordContextAssembled("prompt", 0);
  const llmId = g.recordLlmCall(1, 5);
  g.recordToolCall("Read", 1, llmId);
  
  const edges = g.getAllEdges();
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, llmId);
  assert.equal(edges[0].relation, "triggers");
}

// Blocked tools
{
  const g = new TurnProvenanceGraph("sess1");
  g.recordBlockedTool("exec", "no-exec-when-external", 1);
  const summary = g.summary();
  assert.deepEqual(summary.toolsBlocked, ["exec"]);
}

// Seal prevents modification
{
  const g = new TurnProvenanceGraph("sess1");
  g.recordContextAssembled("prompt", 0);
  const summary = g.seal();
  assert.equal(g.sealed, true);
  assert.equal(summary.nodeCount, 1);
  
  assert.throws(() => g.addNode({ id: "x", kind: "input", trust: "local" }), /sealed/);
  assert.throws(() => g.addEdge({ from: "a", to: "b", relation: "triggers" }), /sealed/);
}

// toJSON
{
  const g = new TurnProvenanceGraph("sess1", "turn-fixed");
  g.recordContextAssembled("prompt", 1);
  const json = g.toJSON();
  assert.equal(json.turnId, "turn-fixed");
  assert.equal(json.sessionKey, "sess1");
  assert.ok(Array.isArray(json.nodes));
  assert.ok(Array.isArray(json.edges));
}

// --- ProvenanceStore ---

// Start and complete turns
{
  const store = new ProvenanceStore(5);
  const g = store.startTurn("s1");
  assert.ok(g);
  assert.equal(store.getActive("s1"), g);
  
  g.recordContextAssembled("prompt", 0);
  const summary = store.completeTurn("s1");
  assert.ok(summary);
  assert.equal(summary!.nodeCount, 1);
  assert.equal(store.getActive("s1"), undefined);
  assert.equal(store.getCompleted().length, 1);
}

// Starting new turn archives existing
{
  const store = new ProvenanceStore(5);
  store.startTurn("s1");
  store.startTurn("s1"); // replaces, archives old
  assert.equal(store.getCompleted().length, 1);
}

// Max completed graphs respected
{
  const store = new ProvenanceStore(3);
  for (let i = 0; i < 5; i++) {
    const g = store.startTurn(`s${i}`);
    g.recordContextAssembled("p", 0);
    store.completeTurn(`s${i}`);
  }
  assert.equal(store.getCompleted().length, 3);
}

console.log("✅ provenance-graph tests passed");
