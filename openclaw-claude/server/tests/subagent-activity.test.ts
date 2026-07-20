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

describe("createSubagentActivityEmitter — toolActivity generalization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits kind:toolActivity with the tool name when armed for a plain native tool", () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const emitter = createSubagentActivityEmitter({
      notify: (method, params) => calls.push({ method, params }),
      threadId: "thread-1",
      turnId: "turn-1",
      intervalMs: 100,
    });
    emitter.arm("toolActivity", "Bash");
    vi.advanceTimersByTime(250);
    emitter.disarm();
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual({
      method: "turn/progress",
      params: { threadId: "thread-1", turnId: "turn-1", kind: "toolActivity", tool: "Bash" },
    });
  });

  it("defaults to subagentActivity when armed with no kind (back-compat)", () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const emitter = createSubagentActivityEmitter({
      notify: (method, params) => calls.push({ method, params }),
      threadId: "t",
      turnId: "u",
      intervalMs: 100,
    });
    emitter.arm();
    vi.advanceTimersByTime(150);
    emitter.disarm();
    expect((calls[0]!.params as { kind: string }).kind).toBe("subagentActivity");
  });

  it("re-arming with a different kind switches the emitted kind without stacking timers", () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const emitter = createSubagentActivityEmitter({
      notify: (method, params) => calls.push({ method, params }),
      threadId: "t",
      turnId: "u",
      intervalMs: 100,
    });
    emitter.arm("toolActivity", "Read");
    emitter.arm("subagentActivity", "Agent"); // same armed window, kind upgraded
    vi.advanceTimersByTime(250);
    emitter.disarm();
    expect(calls.length).toBe(2); // one timer, not two
    expect((calls[0]!.params as { kind: string }).kind).toBe("subagentActivity");
  });
});

describe("createSubagentActivityEmitter — evidence-gated vouching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function scriptedSampler(script: Array<{ alive?: boolean; evidence: boolean }>) {
    let i = 0;
    return {
      sample: () => {
        const step = script[Math.min(i++, script.length - 1)]!;
        return Promise.resolve({
          childAlive: step.alive ?? true,
          cpuMsDelta: step.evidence ? 25 : 0,
          ioBytesDelta: 0,
          descendantCount: 1,
          descendantChurn: false,
        });
      },
    };
  }

  it("keeps vouching while evidence flows, grace-emits briefly without it, then goes silent, and resumes", async () => {
    const calls: unknown[] = [];
    const emitter = createSubagentActivityEmitter({
      notify: (_m, params) => calls.push(params),
      threadId: "t",
      turnId: "u",
      intervalMs: 100,
      maxIdleTicks: 3,
      evidenceSampler: scriptedSampler([
        { evidence: true },  // tick 1 → emit
        { evidence: false }, // tick 2 → grace 1 → emit
        { evidence: false }, // tick 3 → grace 2 → emit
        { evidence: false }, // tick 4 → grace exhausted → SILENT
        { evidence: false }, // tick 5 → SILENT
        { evidence: true },  // tick 6 → evidence back → emit
      ]),
    });
    emitter.arm("toolActivity", "Bash");
    await vi.advanceTimersByTimeAsync(650);
    emitter.disarm();
    expect(calls.length).toBe(4); // ticks 1,2,3,6
  });

  it("disarms itself the moment the child tree is gone", async () => {
    const calls: unknown[] = [];
    const emitter = createSubagentActivityEmitter({
      notify: (_m, params) => calls.push(params),
      threadId: "t",
      turnId: "u",
      intervalMs: 100,
      evidenceSampler: scriptedSampler([
        { evidence: true },
        { alive: false, evidence: false }, // tree dead → self-disarm
        { evidence: true },                // would emit if still armed — must not
      ]),
    });
    emitter.arm("toolActivity", "Bash");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(1); // only the first tick
    emitter.disarm(); // idempotent
  });

  it("re-arming resets the idle-grace budget", async () => {
    const calls: unknown[] = [];
    const emitter = createSubagentActivityEmitter({
      notify: (_m, params) => calls.push(params),
      threadId: "t",
      turnId: "u",
      intervalMs: 100,
      maxIdleTicks: 2,
      evidenceSampler: scriptedSampler([
        { evidence: false }, // grace 1 → emit
        { evidence: false }, // grace exhausted → silent
        { evidence: false }, // (re-armed before this tick) grace 1 again → emit
      ]),
    });
    emitter.arm("toolActivity", "Read");
    await vi.advanceTimersByTimeAsync(250);
    emitter.arm("toolActivity", "Write"); // new tool call in the same window
    await vi.advanceTimersByTimeAsync(100);
    emitter.disarm();
    expect(calls.length).toBe(2);
  });
});
