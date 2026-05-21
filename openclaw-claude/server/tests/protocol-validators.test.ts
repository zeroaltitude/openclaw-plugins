import { describe, expect, it, vi } from "vitest";

import { buildModelListResponse } from "../src/models.js";
import { validateOutbound, type ValidatorName } from "../src/validators.js";

const captured: Array<{ level: string; msg: string; meta?: unknown }> = [];
const logger = {
  debug: () => {},
  info: () => {},
  warn: (msg: string, meta?: unknown) => {
    captured.push({ level: "warn", msg, meta });
  },
  error: () => {},
};

function expectValidates(name: ValidatorName, value: unknown): void {
  // validateOutbound silently passes when valid; warns when invalid.
  // We trigger validation by running with NODE_ENV !== "production".
  vi.stubEnv("NODE_ENV", "test");
  captured.length = 0;
  validateOutbound(name, value, logger);
  expect(captured).toHaveLength(0);
}

function expectFails(name: ValidatorName, value: unknown): void {
  vi.stubEnv("NODE_ENV", "test");
  captured.length = 0;
  validateOutbound(name, value, logger);
  expect(captured.length).toBeGreaterThan(0);
  expect(captured[0]!.msg).toMatch(/failed schema validation/);
}

function canonicalThread(): Record<string, unknown> {
  return {
    id: "abc",
    sessionId: "abc",
    cliVersion: "0.1.0",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    cwd: "/tmp/x",
    ephemeral: false,
    modelProvider: "anthropic",
    preview: "",
    source: "appServer",
    status: { type: "idle" },
    turns: [],
  };
}

function canonicalThreadStart(): Record<string, unknown> {
  return {
    thread: canonicalThread(),
    model: "claude-opus-4-7",
    modelProvider: "anthropic",
    cwd: "/tmp/x",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    serviceTier: null,
    instructionSources: [],
    runtimeWorkspaceRoots: [],
  };
}

describe("validators / canonical shapes", () => {
  it("threadStart response validates against codex's ajv schema", () => {
    expectValidates("threadStart", canonicalThreadStart());
  });

  it("threadResume response validates against codex's ajv schema", () => {
    expectValidates("threadResume", canonicalThreadStart());
  });

  it("modelList response (real Anthropic catalog) validates", () => {
    expectValidates("modelList", buildModelListResponse());
  });

  it("threadStart rejects a Thread missing required fields", () => {
    const bad = canonicalThreadStart();
    delete (bad.thread as Record<string, unknown>).cliVersion;
    expectFails("threadStart", bad);
  });

  it("threadStart rejects a non-integer startedAt-equivalent (cliVersion type)", () => {
    const bad = canonicalThreadStart();
    (bad.thread as Record<string, unknown>).cliVersion = 12345;
    expectFails("threadStart", bad);
  });

  it("turnStart response validates with a minimal canonical Turn", () => {
    const value = {
      turn: {
        id: "u-1",
        threadId: "abc",
        status: "inProgress",
        startedAt: 1_700_000_000,
        completedAt: null,
        durationMs: null,
        items: [],
      },
    };
    expectValidates("turnStart", value);
  });

  it("turnCompleted notification validates (requires top-level threadId + turn)", () => {
    const value = {
      threadId: "abc",
      turn: {
        id: "u-1",
        threadId: "abc",
        status: "completed",
        startedAt: 1_700_000_000,
        completedAt: 1_700_000_010,
        durationMs: 10_000,
        items: [],
      },
    };
    expectValidates("turnCompleted", value);
  });
});
