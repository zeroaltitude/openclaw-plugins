import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSubagentActivityEmitter,
  SUBAGENT_ACTIVITY_INTERVAL_MS,
} from "../src/turn-runner.js";

/**
 * The native-subagent activity emitter keeps a parent turn alive while a
 * native `Agent`/`Task` subagent runs in an SDK child process that bubbles no
 * progress to the parent iterator. It does so by emitting periodic
 * NON-heartbeat `turn/progress {kind:"subagentActivity"}` notifications, which
 * the OpenClaw consumer's idle watchdog counts as real activity (unlike the
 * 30s heartbeat, which it deliberately ignores). These tests pin the
 * arm/disarm/emit semantics with fake timers.
 */
describe("createSubagentActivityEmitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(intervalMs?: number) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const emitter = createSubagentActivityEmitter({
      notify: (method, params) => calls.push({ method, params }),
      threadId: "thread-1",
      turnId: "turn-1",
      intervalMs,
    });
    return { calls, emitter };
  }

  it("emits nothing until armed", () => {
    const { calls } = setup();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS * 3);
    expect(calls).toHaveLength(0);
  });

  it("emits a non-heartbeat subagentActivity progress while armed", () => {
    const { calls, emitter } = setup();
    emitter.arm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("turn/progress");
    expect(calls[0].params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "subagentActivity",
    });
    // Crucially NOT the heartbeat kind the consumer ignores.
    expect((calls[0].params as { kind: string }).kind).not.toBe("heartbeat");
  });

  it("keeps emitting on each interval while armed", () => {
    const { calls, emitter } = setup();
    emitter.arm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS * 3);
    expect(calls).toHaveLength(3);
  });

  it("stops emitting after disarm", () => {
    const { calls, emitter } = setup();
    emitter.arm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS);
    emitter.disarm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS * 5);
    expect(calls).toHaveLength(1);
  });

  it("arm() is idempotent — double-arm does not double the cadence", () => {
    const { calls, emitter } = setup();
    emitter.arm();
    emitter.arm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS);
    expect(calls).toHaveLength(1);
  });

  it("disarm() is idempotent and safe when never armed", () => {
    const { calls, emitter } = setup();
    expect(() => emitter.disarm()).not.toThrow();
    emitter.arm();
    emitter.disarm();
    expect(() => emitter.disarm()).not.toThrow();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS * 5);
    expect(calls).toHaveLength(0);
  });

  it("can be re-armed after disarm (subagent then resumes then another subagent)", () => {
    const { calls, emitter } = setup();
    emitter.arm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS); // 1
    emitter.disarm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS * 2); // silent
    emitter.arm();
    vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS); // 2
    expect(calls).toHaveLength(2);
  });

  it("fires below the 30s heartbeat cadence so it lands inside the idle window", () => {
    expect(SUBAGENT_ACTIVITY_INTERVAL_MS).toBeLessThan(30_000);
  });

  it("swallows notify errors via onError without throwing out of the timer", () => {
    const errors: unknown[] = [];
    const emitter = createSubagentActivityEmitter({
      notify: () => {
        throw new Error("transport closed");
      },
      threadId: "t",
      turnId: "u",
      onError: (e) => errors.push(e),
    });
    emitter.arm();
    expect(() => vi.advanceTimersByTime(SUBAGENT_ACTIVITY_INTERVAL_MS)).not.toThrow();
    expect(errors).toHaveLength(1);
    emitter.disarm();
  });
});
