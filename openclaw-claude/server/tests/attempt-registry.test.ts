import { describe, expect, it, vi } from "vitest";

import {
  AttemptRegistry,
  computeAttemptFingerprint,
  diffAttemptFingerprintInputs,
  type AttemptEntry,
  type AttemptFingerprintInput,
} from "../src/attempt-registry.js";
import type { Logger } from "../src/transport.js";
import { ControllableUserInputQueue } from "../src/user-input.js";

const BASE_FINGERPRINT_INPUT: AttemptFingerprintInput = {
  model: "claude-x",
  thinking: null,
  cwd: undefined,
  disallowedTools: [],
  toolAliases: {},
  fastMode: false,
  allowAll: false,
  systemPromptAppend: undefined,
  mcpServersConfig: undefined,
  dynamicTools: [],
};

function makeLogger(): Logger & { calls: Record<"debug" | "info" | "warn" | "error", unknown[][]> } {
  const calls = { debug: [], info: [], warn: [], error: [] } as Record<
    "debug" | "info" | "warn" | "error",
    unknown[][]
  >;
  return {
    calls,
    debug: (...args: unknown[]) => void calls.debug.push(args),
    info: (...args: unknown[]) => void calls.info.push(args),
    warn: (...args: unknown[]) => void calls.warn.push(args),
    error: (...args: unknown[]) => void calls.error.push(args),
  };
}

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
    fingerprintInput: BASE_FINGERPRINT_INPUT,
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

describe("diffAttemptFingerprintInputs", () => {
  const base: AttemptFingerprintInput = {
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

  it("returns no changes for identical input", () => {
    expect(diffAttemptFingerprintInputs(base, { ...base })).toEqual([]);
  });

  it("is insensitive to array/object key ordering, like the fingerprint itself", () => {
    const reordered = { ...base, disallowedTools: ["Task", "Agent"] };
    expect(diffAttemptFingerprintInputs(base, reordered)).toEqual([]);
  });

  it.each([
    ["model", { model: "claude-y" }, "model"],
    ["thinking", { thinking: { type: "disabled" } }, "thinking"],
    ["cwd", { cwd: "/other" }, "cwd"],
    ["disallowedTools", { disallowedTools: ["Agent"] }, "disallowedTools"],
    ["toolAliases", { toolAliases: {} }, "toolAliases"],
    ["fastMode", { fastMode: true }, "fastMode"],
    ["allowAll", { allowAll: true }, "allowAll"],
    ["systemPromptAppend", { systemPromptAppend: "different" }, "systemPromptAppend"],
    ["mcpServersConfig", { mcpServersConfig: undefined }, "mcpServersConfig"],
  ])("reports %s alone when only that field changes", (_label, patch, expectedField) => {
    expect(diffAttemptFingerprintInputs(base, { ...base, ...patch } as AttemptFingerprintInput)).toEqual([
      expectedField,
    ]);
  });

  it("reports dynamicTools with a before/after tool count, not just the field name", () => {
    // This is the case behind openclaw-c6p: an MCP disconnect/reconnect cycle
    // changes the dynamic-tools set mid-conversation, forcing a genuinely new
    // attempt on the next turn even though nothing about the request changed.
    // The count makes that story legible directly from the discard log line.
    const disconnected = { ...base, dynamicTools: [] };
    expect(diffAttemptFingerprintInputs(base, disconnected)).toEqual(["dynamicTools (1 -> 0 tools)"]);
  });

  it("reports multiple changed fields together", () => {
    const changed = { ...base, model: "claude-y", fastMode: true };
    expect(diffAttemptFingerprintInputs(base, changed)).toEqual(["model", "fastMode"]);
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

  it("discard logs the threadId, reason, and any extra details at info level", () => {
    const logger = makeLogger();
    const registry = new AttemptRegistry(logger);
    const entry = makeEntry();
    registry.set(entry.threadId, entry);

    registry.discard(entry.threadId, "attempt fingerprint changed", { changedFields: ["model"] });

    expect(logger.calls.info).toHaveLength(1);
    const [message, context] = logger.calls.info[0];
    expect(message).toContain("discarding attempt");
    expect(context).toMatchObject({
      threadId: entry.threadId,
      reason: "attempt fingerprint changed",
      changedFields: ["model"],
    });
  });

  it("warns when an attempt is discarded with no turn awaiting its result — the silent-kill case (openclaw-c6p)", () => {
    // This is exactly the gap that made a backgrounded `run_in_background`
    // shell job impossible to diagnose: the turn that started it had already
    // returned (no currentReject to notify) by the time a later turn's
    // fingerprint mismatch discarded the subprocess out from under it.
    const logger = makeLogger();
    const registry = new AttemptRegistry(logger);
    const entry = makeEntry();
    entry.currentReject = null; // no turn is watching this attempt right now
    registry.set(entry.threadId, entry);

    registry.discard(entry.threadId, "attempt fingerprint changed");

    expect(logger.calls.warn).toHaveLength(1);
    const [message, context] = logger.calls.warn[0];
    expect(message).toContain("silently killed");
    expect(context).toMatchObject({ threadId: entry.threadId, reason: "attempt fingerprint changed" });
  });

  it("does not warn when a currentReject was present to notify — only the silent case is a warning", () => {
    const logger = makeLogger();
    const registry = new AttemptRegistry(logger);
    const entry = makeEntry();
    entry.currentReject = vi.fn();
    entry.currentHandler = () => {};
    registry.set(entry.threadId, entry);

    registry.discard(entry.threadId, "turn interrupted");

    expect(logger.calls.warn).toHaveLength(0);
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

  it("sweepIdle never discards an attempt with a turn currently in flight, no matter how long lastUsedAtMs is stale", () => {
    // Regression: lastUsedAtMs is only refreshed when a turn STARTS (see
    // turn-runner.ts), never while it runs. Before this guard, any turn
    // running longer than maxIdleMs — not an idle attempt, one actively
    // executing — got its subprocess killed out from under it, surfacing as
    // "attempt discarded: attempt idle timeout" and failing the turn.
    // Observed live: a cron turn running ~11.3 minutes was discarded by a
    // 10-minute idle sweep despite being in flight the whole time.
    const registry = new AttemptRegistry();
    const longRunning = makeEntry("thread-long-running", {
      lastUsedAtMs: Date.now() - 60 * 60_000, // "idle" a full hour by the clock alone
      currentHandler: () => {}, // a turn is actively awaiting this attempt's result
    });
    registry.set(longRunning.threadId, longRunning);

    registry.sweepIdle(30_000);

    expect(registry.get("thread-long-running")).toBe(longRunning);
    expect(longRunning.closed).toBe(false);
  });

  it("sweepIdle still discards a genuinely idle entry (no turn in flight) past the threshold", () => {
    const registry = new AttemptRegistry();
    const idleBetweenTurns = makeEntry("thread-idle", {
      lastUsedAtMs: Date.now() - 60_000,
      currentHandler: null, // no turn awaiting — genuinely idle between turns
    });
    registry.set(idleBetweenTurns.threadId, idleBetweenTurns);

    registry.sweepIdle(30_000);

    expect(registry.get("thread-idle")).toBeUndefined();
    expect(idleBetweenTurns.closed).toBe(true);
  });
});
