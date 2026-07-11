import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActiveTurn } from "../src/active-turns.js";
import { AttemptRegistry } from "../src/attempt-registry.js";
import type { ThreadMeta } from "../src/thread-store.js";
import type { Logger } from "../src/transport.js";
import { runTurn, type RunTurnInput } from "../src/turn-runner.js";

/**
 * Pins the core fix for "conversation blackouts": before this redesign,
 * every turn spawned (and, on completion, killed) its own `claude`
 * subprocess via a fresh `query()` call, because the input iterable fed to
 * it was closed immediately after the turn's message. Anything a turn
 * backgrounded died with that subprocess the moment the turn's response
 * finished, even though nothing had crashed.
 *
 * The fix keeps that iterable open and reuses the live `Query` across turns
 * whenever the attempt-defining SDK options haven't changed (same
 * fingerprint — see attempt-registry.ts), only spawning a new subprocess
 * when they do (a genuine new attempt) or the attempt was discarded
 * (interrupt, idle sweep, crash).
 *
 * These tests mock `@anthropic-ai/claude-agent-sdk`'s `query()` with a fake
 * that stays "alive" across pushes into its prompt iterable — mirroring the
 * real SDK's `Query.streamInput()`, which only ends the subprocess once that
 * iterable is exhausted — so `query` call count is a direct proxy for
 * subprocess-spawn count.
 */

const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
  return (async function* () {
    for await (const _msg of params.prompt) {
      yield { type: "assistant", message: { stop_reason: "end_turn" } };
      yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
    }
  })();
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: never) => queryMock(params),
}));

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeMeta(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: 1,
    id: overrides.id ?? randomUUID(),
    sessionId: overrides.id ?? randomUUID(),
    cliVersion: "test",
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp",
    model: "claude-test-model",
    modelProvider: "anthropic",
    approvalPolicy: "never",
    approvalsReviewer: "none" as ThreadMeta["approvalsReviewer"],
    sandbox: "danger-full-access" as ThreadMeta["sandbox"],
    ...overrides,
  };
}

function makeTurn(threadId: string): ActiveTurn {
  const nowMs = Date.now();
  return {
    threadId,
    turnId: randomUUID(),
    abortController: new AbortController(),
    startedAtSeconds: Math.floor(nowMs / 1000),
    startedAtMs: nowMs,
    items: [],
    status: "inProgress",
  };
}

function makeArgs(overrides: {
  meta: ThreadMeta;
  turn: ActiveTurn;
  attemptRegistry: AttemptRegistry;
  modelOverride?: string;
  fastMode?: boolean;
}): RunTurnInput {
  return {
    meta: overrides.meta,
    turn: overrides.turn,
    input: [{ type: "text", text: "hello" }],
    effort: null,
    fastMode: overrides.fastMode ?? null,
    modelOverride: overrides.modelOverride,
    sessionStore: {} as RunTurnInput["sessionStore"],
    threadStore: {
      messagesPath: (id: string) => `/nonexistent/${id}/messages.jsonl`,
    } as RunTurnInput["threadStore"],
    attemptRegistry: overrides.attemptRegistry,
    notify: () => {},
    requestClient: vi.fn(),
    logger: NOOP_LOGGER,
  };
}

describe("runTurn persistent attempts", () => {
  afterEach(() => {
    queryMock.mockClear();
  });

  it("reuses the same subprocess across turns with a matching fingerprint", async () => {
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();

    const turn1 = makeTurn(meta.id);
    const { finalTurn: t1 } = await runTurn(makeArgs({ meta, turn: turn1, attemptRegistry }));
    expect(t1.status).toBe("completed");
    expect(queryMock).toHaveBeenCalledTimes(1);

    const turn2 = makeTurn(meta.id);
    const { finalTurn: t2 } = await runTurn(makeArgs({ meta, turn: turn2, attemptRegistry }));
    expect(t2.status).toBe("completed");
    // Still just one subprocess spawn — the second turn was fed into the
    // same live Query via its still-open input queue.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(attemptRegistry.size()).toBe(1);
  });

  it("spawns a new subprocess when the attempt fingerprint changes (model switch)", async () => {
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();

    const turn1 = makeTurn(meta.id);
    await runTurn(makeArgs({ meta, turn: turn1, attemptRegistry }));
    expect(queryMock).toHaveBeenCalledTimes(1);

    const turn2 = makeTurn(meta.id);
    await runTurn(
      makeArgs({ meta, turn: turn2, attemptRegistry, modelOverride: "claude-different-model" }),
    );
    expect(queryMock).toHaveBeenCalledTimes(2);
    // The old attempt was discarded in favor of the new one, not layered on top.
    expect(attemptRegistry.size()).toBe(1);
  });

  it("spawns a new subprocess for a different thread even with an identical fingerprint", async () => {
    const metaA = makeMeta();
    const metaB = makeMeta();
    const attemptRegistry = new AttemptRegistry();

    await runTurn(makeArgs({ meta: metaA, turn: makeTurn(metaA.id), attemptRegistry }));
    await runTurn(makeArgs({ meta: metaB, turn: makeTurn(metaB.id), attemptRegistry }));

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(attemptRegistry.size()).toBe(2);
  });

  it("spawns a fresh subprocess after the prior attempt was discarded (e.g. turn/interrupt)", async () => {
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();

    const turn1 = makeTurn(meta.id);
    await runTurn(makeArgs({ meta, turn: turn1, attemptRegistry }));
    expect(queryMock).toHaveBeenCalledTimes(1);

    attemptRegistry.discard(meta.id, "turn interrupted");
    expect(attemptRegistry.size()).toBe(0);

    const turn2 = makeTurn(meta.id);
    await runTurn(makeArgs({ meta, turn: turn2, attemptRegistry }));
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an attempt the idle sweep has discarded", async () => {
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();

    await runTurn(makeArgs({ meta, turn: makeTurn(meta.id), attemptRegistry }));
    expect(queryMock).toHaveBeenCalledTimes(1);

    attemptRegistry.sweepIdle(-1); // force everything to look idle
    expect(attemptRegistry.size()).toBe(0);

    await runTurn(makeArgs({ meta, turn: makeTurn(meta.id), attemptRegistry }));
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
