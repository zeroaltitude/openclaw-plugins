import { strict as assert } from "node:assert";
import { ApprovalStore } from "../approval-store.js";

// approve() adds tool to approved set
{
  const store = new ApprovalStore();
  store.approve("session1", "exec");
  assert.ok(store.isApproved("session1", "exec"));
  assert.ok(!store.isApproved("session1", "message"));
  assert.ok(!store.isApproved("session2", "exec"));
}

// approveAll() approves all pending + adds wildcard
{
  const store = new ApprovalStore();
  store.addPending({ sessionKey: "s1", toolName: "exec", taintLevel: "external", reason: "test", requestedAt: Date.now() });
  store.addPending({ sessionKey: "s1", toolName: "message", taintLevel: "external", reason: "test", requestedAt: Date.now() });
  store.approveAll("s1");
  assert.ok(store.isApproved("s1", "exec"));
  assert.ok(store.isApproved("s1", "message"));
  assert.ok(store.isApproved("s1", "anything_else"));
  assert.deepEqual(store.getPending("s1"), []);
}

// isApproved() with wildcard
{
  const store = new ApprovalStore();
  store.approveAll("s1");
  assert.ok(store.isApproved("s1", "any_tool"));
  assert.ok(store.isApproved("s1", "another_tool"));
}

// addPending() doesn't duplicate
{
  const store = new ApprovalStore();
  store.addPending({ sessionKey: "s1", toolName: "exec", taintLevel: "external", reason: "test", requestedAt: 1 });
  store.addPending({ sessionKey: "s1", toolName: "exec", taintLevel: "external", reason: "test2", requestedAt: 2 });
  assert.equal(store.getPending("s1").length, 1);
}

// clearSession() removes everything
{
  const store = new ApprovalStore();
  store.approve("s1", "exec");
  store.addPending({ sessionKey: "s1", toolName: "message", taintLevel: "external", reason: "test", requestedAt: 1 });
  store.clearSession("s1");
  assert.ok(!store.isApproved("s1", "exec"));
  assert.deepEqual(store.getPending("s1"), []);
  assert.deepEqual(store.getApproved("s1"), []);
}

// getPending() returns pending list
{
  const store = new ApprovalStore();
  store.addPending({ sessionKey: "s1", toolName: "exec", taintLevel: "external", reason: "r1", requestedAt: 1 });
  store.addPending({ sessionKey: "s1", toolName: "message", taintLevel: "untrusted", reason: "r2", requestedAt: 2 });
  const pending = store.getPending("s1");
  assert.equal(pending.length, 2);
  assert.equal(pending[0].toolName, "exec");
  assert.equal(pending[1].toolName, "message");
}

// approve() removes from pending
{
  const store = new ApprovalStore();
  store.addPending({ sessionKey: "s1", toolName: "exec", taintLevel: "external", reason: "test", requestedAt: 1 });
  store.addPending({ sessionKey: "s1", toolName: "message", taintLevel: "external", reason: "test", requestedAt: 2 });
  store.approve("s1", "exec");
  const pending = store.getPending("s1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolName, "message");
}

// getApproved() returns approved tools
{
  const store = new ApprovalStore();
  store.approve("s1", "exec");
  store.approve("s1", "message");
  const approved = store.getApproved("s1");
  assert.ok(approved.includes("exec"));
  assert.ok(approved.includes("message"));
}

console.log("✅ approval-store tests passed");
