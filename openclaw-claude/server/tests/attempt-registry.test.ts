import { describe, expect, it, vi } from "vitest";

import { AttemptRegistry, computeAttemptFingerprint, type AttemptEntry } from "../src/attempt-registry.js";
import { ControllableUserInputQueue } from "../src/user-input.js";

/**
 * These pin the persistence primitive behind the run/attempt/turn
 * redesign: a live `Query` subprocess is kept alive across turns as long as
 * the attempt-defining SDK options (fingerprint) don't change, and torn
 * down cleanly (input queue closed, abortController aborted, any in-flight
 * turn rejected) whenever it's discarded — fingerprint change, interrupt,
 * idle timeout, or process shutdown.
 */

function makeEntry(threadId = "thread-1", overrides: Partial<AttemptEntry> = {}): AttemptEntry {
  const now = Date.now();
  return {
    threadId,
    fingerprint: "fp-1",
    inputQueue: new ControllableUserInputQueue(),
    abortController: new AbortController(),
    liveTurnRef: { turn: { threadId, turnId: "turn-1" } as never },
    currentHandler: null,
    currentReject: null,
    closed: false,
    createdAtMs: now,
    lastUsedAtMs: now,
    ...overrides,
  };
}

describe("computeAttemptFingerprint", () => {
  const base = {
    model: "claude-x",
    thinking: { type: "enabled", budgetTokens: 1024 },
    cwd: "/work",
    disallowedTools: ["Agent", "Task"],
    toolAliases: { Agent: "mcp__openclaw__sessions_spawn" },
    fastMode: false,
    allowAll: false,
    systemPromptAppend: "be nice",
    mcpServersConfig: { foo: { command: "bar" } },
    dynamicTools: [{ name: "toolA", description: "does a thing", inputSchema: { type: "object" } }],
  };

  it("is stable for identical input", () => {
    expect(computeAttemptFingerprint(base)).toBe(computeAttemptFingerprint({ ...base }));
  });

  it("is insensitive to array/object key ordering", () => {
    const reordered = {
      ...base,
      disallowedTools: ["Task", "Agent"],
      dynamicTools: [...base.dynamicTools],
    };
    expect(computeAttemptFingerprint(base)).toBe(computeAttemptFingerprint(reordered));
  });

  it.each([
    ["model", { model: "claude-y" }],
    ["thinking", { thinking: { type: "disabled" } }],
    ["cwd", { cwd: "/other" }],
    ["disallowedTools", { disallowedTools: ["Agent"] }],
    ["toolAliases", { toolAliases: {} }],
    ["fastMode", { fastMode: true }],
    ["allowAll", { allowAll: true }],
    ["systemPromptAppend", { systemPromptAppend: "different" }],
    ["mcpServersConfig", { mcpServersConfig: undefined }],
    ["dynamicTools", { dynamicTools: [] }],
  ])("changes when %s changes", (_label, patch) => {
    expect(computeAttemptFingerprint(base)).not.toBe(
      computeAttemptFingerprint({ ...base, ...patch } as typeof base),
    );
  });
});

describe("AttemptRegistry", () => {
  it("get/set round-trips an entry", () => {
    const registry = new AttemptRegistry();
    const entry = makeEntry();
    registry.set(entry.threadId, entry);
    expect(registry.get(entry.threadId)).toBe(entry);
    expect(registry.size()).toBe(1);
  });

  it("discard closes the input queue, aborts the controller, and removes the entry", () => {
    const registry = new AttemptRegistry();
    const entry = makeEntry();
    registry.set(entry.threadId, entry);

    registry.discard(entry.threadId, "test reason");

    expect(registry.get(entry.threadId)).toBeUndefined();
    expect(entry.closed).toBe(true);
    expect(entry.inputQueue.isClosed()).toBe(true);
    expect(entry.abortController.signal.aborted).toBe(true);
  });

  it("discard rejects an in-flight currentReject with a descriptive error", () => {
    const registry = new AttemptRegistry();
    const entry = makeEntry();
    registry.set(entry.threadId, entry);
    const reject = vi.fn();
    entry.currentReject = reject;
    entry.currentHandler = () => {};

    registry.discard(entry.threadId, "turn interrupted");

    expect(reject).toHaveBeenCalledTimes(1);
    const err = reject.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("turn interrupted");
    expect(entry.currentHandler).toBeNull();
    expect(entry.currentReject).toBeNull();
  });

  it("discard is idempotent (no double-abort, no double-reject)", () => {
    const registry = new AttemptRegistry();
    const entry = makeEntry();
    registry.set(entry.threadId, entry);
    const reject = vi.fn();
    entry.currentReject = reject;

    registry.discard(entry.threadId, "first");
    registry.discard(entry.threadId, "second");

    expect(reject).toHaveBeenCalledTimes(1);
  });

  it("discard on an unknown thread is a no-op", () => {
    const registry = new AttemptRegistry();
    expect(() => registry.discard("nope", "reason")).not.toThrow();
  });

  it("discardAll tears down every live entry", () => {
    const registry = new AttemptRegistry();
    const a = makeEntry("thread-a");
    const b = makeEntry("thread-b");
    registry.set(a.threadId, a);
    registry.set(b.threadId, b);

    registry.discardAll("shutdown");

    expect(registry.size()).toBe(0);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
  });

  it("removeIfCurrent only removes the entry if it's still the registered one", () => {
    const registry = new AttemptRegistry();
    const stale = makeEntry("thread-1");
    registry.set(stale.threadId, stale);

    const fresh = makeEntry("thread-1");
    registry.set(fresh.threadId, fresh); // supersedes `stale`

    registry.removeIfCurrent(stale); // pump cleanup racing a newer attempt
    expect(registry.get("thread-1")).toBe(fresh);

    registry.removeIfCurrent(fresh);
    expect(registry.get("thread-1")).toBeUndefined();
  });

  it("sweepIdle discards only entries past the idle threshold", () => {
    const registry = new AttemptRegistry();
    const stale = makeEntry("thread-stale", { lastUsedAtMs: Date.now() - 60_000 });
    const fresh = makeEntry("thread-fresh", { lastUsedAtMs: Date.now() });
    registry.set(stale.threadId, stale);
    registry.set(fresh.threadId, fresh);

    registry.sweepIdle(30_000);

    expect(registry.get("thread-stale")).toBeUndefined();
    expect(stale.closed).toBe(true);
    expect(registry.get("thread-fresh")).toBe(fresh);
    expect(fresh.closed).toBe(false);
  });
});
