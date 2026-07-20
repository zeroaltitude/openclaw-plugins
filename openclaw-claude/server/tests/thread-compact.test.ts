import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveTurnRegistry } from "../src/active-turns.js";
import { AttemptRegistry } from "../src/attempt-registry.js";
import { createThreadCompactStartHandler } from "../src/handlers/thread-compact.js";
import type { OpenClawSessionStore } from "../src/session-store.js";
import type { ThreadMeta, ThreadStore } from "../src/thread-store.js";
import type { Logger } from "../src/transport.js";
import { runTurn, type RunTurnInput } from "../src/turn-runner.js";
import type { ActiveTurn } from "../src/active-turns.js";

/**
 * Compaction rides the SDK's own `/compact` slash command: the bridge sends
 * it as a user message, the CLI performs the compaction and reports back with
 * a `compact_boundary` system message (token accounting) plus a `status`
 * system message carrying `compact_result`. These tests fake that exchange
 * per-scenario via a configurable script.
 */

type ScriptedMessage = Record<string, unknown>;

let script: ScriptedMessage[] = [];

const queryMock = vi.fn(
  (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    return (async function* () {
      for await (const _msg of params.prompt) {
        for (const msg of script) {
          yield msg;
        }
      }
    })();
  },
);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: never) => queryMock(params),
}));

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const COMPACT_BOUNDARY: ScriptedMessage = {
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: {
    trigger: "manual",
    pre_tokens: 180_000,
    post_tokens: 12_000,
    duration_ms: 4200,
  },
};

const STATUS_SUCCESS: ScriptedMessage = {
  type: "system",
  subtype: "status",
  status: null,
  compact_result: "success",
};

const STATUS_FAILED: ScriptedMessage = {
  type: "system",
  subtype: "status",
  status: null,
  compact_result: "failed",
  compact_error: "summarization request failed",
};

const RESULT: ScriptedMessage = {
  type: "result",
  usage: { input_tokens: 1, output_tokens: 1 },
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

function makeRunTurnArgs(overrides: {
  meta: ThreadMeta;
  turn: ActiveTurn;
  attemptRegistry: AttemptRegistry;
  notify?: (method: string, params: unknown) => void;
  compactMode?: boolean;
  input?: RunTurnInput["input"];
}): RunTurnInput {
  return {
    meta: overrides.meta,
    turn: overrides.turn,
    input: overrides.input ?? [{ type: "text", text: "/compact" }],
    effort: null,
    compactMode: overrides.compactMode,
    sessionStore: {} as RunTurnInput["sessionStore"],
    threadStore: {
      messagesPath: (id: string) => `/nonexistent/${id}/messages.jsonl`,
    } as RunTurnInput["threadStore"],
    attemptRegistry: overrides.attemptRegistry,
    notify: overrides.notify ?? (() => {}),
    requestClient: vi.fn(),
    logger: NOOP_LOGGER,
  };
}

describe("runTurn compactMode", () => {
  afterEach(() => {
    queryMock.mockClear();
    script = [];
  });

  it("captures boundary + success and discards the attempt", async () => {
    script = [COMPACT_BOUNDARY, STATUS_SUCCESS, RESULT];
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const turn = makeTurn(meta.id);

    const { finalTurn, compaction } = await runTurn(
      makeRunTurnArgs({
        meta,
        turn,
        attemptRegistry,
        compactMode: true,
        notify: (method, params) => notifications.push({ method, params }),
      }),
    );

    expect(finalTurn.status).toBe("completed");
    expect(compaction?.result).toBe("success");
    expect(compaction?.boundary).toEqual({
      trigger: "manual",
      preTokens: 180_000,
      postTokens: 12_000,
      durationMs: 4200,
    });
    // Compaction rewrote the transcript — the attempt must not be reused.
    expect(attemptRegistry.size()).toBe(0);
    const boundaryNotif = notifications.find((n) => n.method === "thread/compact/boundary");
    expect(boundaryNotif).toBeDefined();
    expect((boundaryNotif?.params as Record<string, unknown>).preTokens).toBe(180_000);
  });

  it("terminates on the compact_result status message when no result follows", async () => {
    // Slash-command turns aren't guaranteed a trailing `result` message —
    // the status message carrying compact_result must settle the turn.
    script = [COMPACT_BOUNDARY, STATUS_SUCCESS];
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();
    const turn = makeTurn(meta.id);

    const { finalTurn, compaction } = await runTurn(
      makeRunTurnArgs({ meta, turn, attemptRegistry, compactMode: true }),
    );

    expect(finalTurn.status).toBe("completed");
    expect(compaction?.result).toBe("success");
    expect(attemptRegistry.size()).toBe(0);
  });

  it("captures a failed compaction with its error", async () => {
    script = [STATUS_FAILED, RESULT];
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();
    const turn = makeTurn(meta.id);

    const { compaction } = await runTurn(
      makeRunTurnArgs({ meta, turn, attemptRegistry, compactMode: true }),
    );

    expect(compaction?.result).toBe("failed");
    expect(compaction?.error).toBe("summarization request failed");
  });

  it("does not change terminal behavior for normal turns", async () => {
    // A normal turn that happens to see an auto-compaction boundary still
    // terminates on `result`, not on compaction status messages.
    script = [
      COMPACT_BOUNDARY,
      { type: "assistant", message: { stop_reason: "end_turn" } },
      RESULT,
    ];
    const meta = makeMeta();
    const attemptRegistry = new AttemptRegistry();
    const turn = makeTurn(meta.id);

    const { finalTurn, compaction } = await runTurn(
      makeRunTurnArgs({
        meta,
        turn,
        attemptRegistry,
        input: [{ type: "text", text: "hello" }],
      }),
    );

    expect(finalTurn.status).toBe("completed");
    // Boundary telemetry is still captured (auto-compaction mid-turn).
    expect(compaction?.boundary?.preTokens).toBe(180_000);
    // Normal turns keep their attempt alive for reuse.
    expect(attemptRegistry.size()).toBe(1);
    attemptRegistry.discardAll("test cleanup");
  });
});

describe("thread/compact/start handler", () => {
  afterEach(() => {
    queryMock.mockClear();
    script = [];
  });

  function makeHandlerDeps(meta: ThreadMeta | null) {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const attemptRegistry = new AttemptRegistry();
    const deps = {
      threadStore: {
        readMeta: async () => meta,
        messagesPath: (id: string) => `/nonexistent/${id}/messages.jsonl`,
      } as unknown as ThreadStore,
      sessionStore: {} as OpenClawSessionStore,
      activeTurns: new ActiveTurnRegistry(),
      attemptRegistry,
      notify: (method: string, params: unknown) => notifications.push({ method, params }),
      requestClient: vi.fn(),
      logger: NOOP_LOGGER,
    };
    return { deps, notifications };
  }

  async function waitForNotification(
    notifications: Array<{ method: string; params: unknown }>,
    method: string,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = notifications.find((n) => n.method === method);
      if (found) return found.params as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`notification ${method} never arrived`);
  }

  it("returns an inProgress turn and reports success via thread/compact/completed", async () => {
    script = [COMPACT_BOUNDARY, STATUS_SUCCESS, RESULT];
    const meta = makeMeta();
    const { deps, notifications } = makeHandlerDeps(meta);
    const handler = createThreadCompactStartHandler(deps);

    const response = (await handler({ threadId: meta.id })) as {
      turn: { id: string; status: string };
    };
    expect(response.turn.status).toBe("inProgress");

    const completed = await waitForNotification(notifications, "thread/compact/completed");
    expect(completed.compacted).toBe(true);
    expect(completed.preTokens).toBe(180_000);
    expect(completed.postTokens).toBe(12_000);
    expect(completed.trigger).toBe("manual");
    expect(completed.error).toBeUndefined();

    // The compaction turn still emits its own terminal record.
    const turnCompleted = await waitForNotification(notifications, "turn/completed");
    expect((turnCompleted.turn as Record<string, unknown>).id).toBe(response.turn.id);
  });

  it("reports compacted:false when the SDK never signals a compaction", async () => {
    // The SDK treated /compact as an ordinary message: normal reply, result,
    // no boundary, no compact_result.
    script = [{ type: "assistant", message: { stop_reason: "end_turn" } }, RESULT];
    const meta = makeMeta();
    const { deps, notifications } = makeHandlerDeps(meta);
    const handler = createThreadCompactStartHandler(deps);

    await handler({ threadId: meta.id });
    const completed = await waitForNotification(notifications, "thread/compact/completed");
    expect(completed.compacted).toBe(false);
    expect((completed.error as Record<string, unknown>).message).toMatch(/did not report/i);
  });

  it("reports compacted:false with the SDK's error on a failed compaction", async () => {
    script = [STATUS_FAILED];
    const meta = makeMeta();
    const { deps, notifications } = makeHandlerDeps(meta);
    const handler = createThreadCompactStartHandler(deps);

    await handler({ threadId: meta.id });
    const completed = await waitForNotification(notifications, "thread/compact/completed");
    expect(completed.compacted).toBe(false);
    expect((completed.error as Record<string, unknown>).message).toBe(
      "summarization request failed",
    );
  });

  it("rejects unknown threads with -32004", async () => {
    const { deps } = makeHandlerDeps(null);
    const handler = createThreadCompactStartHandler(deps);
    await expect(handler({ threadId: "nope" })).rejects.toMatchObject({ code: -32004 });
  });

  it("rejects missing threadId with invalid params", async () => {
    const { deps } = makeHandlerDeps(makeMeta());
    const handler = createThreadCompactStartHandler(deps);
    await expect(handler({})).rejects.toMatchObject({ code: -32602 });
  });
});
