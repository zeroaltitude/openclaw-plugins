/**
 * Tests for `createThreadForkHandler` — the server's thread/fork RPC
 * handler. Covers:
 *   - parent transcript (messages.jsonl) copy on fork
 *   - excludeTurns=true skipping the transcript copy
 *   - the bridge-driven catalog-drift path that overrides
 *     dynamicTools + dynamicToolsFingerprint + mcpServersConfig
 *   - codex-style branch-without-catalog-change inheriting the parent's
 *     tools when overrides are omitted
 *   - thread-not-found surfaces a proper RpcError
 *
 * Tank's 2026-05-22 task-list item #7 — server thread/fork behavior is a
 * low-level continuity path that regresses silently if untested.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadForkHandler } from "../src/handlers/thread-fork.js";
import { ThreadStore } from "../src/thread-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-thread-fork-"));
  tempDirs.push(root);
  return root;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

async function seedParentThread(
  store: ThreadStore,
  overrides: {
    cwd?: string;
    model?: string;
    dynamicTools?: Array<{ name: string; description: string; inputSchema?: unknown }>;
    dynamicToolsFingerprint?: string;
    mcpServersConfig?: Record<string, unknown>;
    transcript?: string;
  } = {},
): Promise<{ threadId: string }> {
  const parent = await store.createThread({
    cwd: overrides.cwd ?? "/tmp/parent-ws",
    model: overrides.model ?? "claude-sonnet-4-6",
    modelProvider: "anthropic",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    cliVersion: "test",
    developerInstructions: "parent instructions",
    dynamicTools: overrides.dynamicTools,
    dynamicToolsFingerprint: overrides.dynamicToolsFingerprint,
    mcpServersConfig: overrides.mcpServersConfig,
  });
  if (overrides.transcript !== undefined) {
    await writeFile(store.messagesPath(parent.id), overrides.transcript);
  }
  return { threadId: parent.id };
}

describe("createThreadForkHandler", () => {
  it("copies the parent's messages.jsonl into the fork by default", async () => {
    const root = await makeStateRoot();
    const logger = makeLogger();
    const store = new ThreadStore(root, logger);
    const { threadId } = await seedParentThread(store, {
      transcript: "line-a\nline-b\nline-c\n",
    });
    const handler = createThreadForkHandler(store, logger);

    const resp = (await handler({ threadId })) as { thread: { id: string; forkedFromId: string } };
    const forkId = resp.thread.id;
    expect(forkId).not.toBe(threadId);
    expect(resp.thread.forkedFromId).toBe(threadId);

    const copied = await readFile(store.messagesPath(forkId), "utf8");
    expect(copied).toBe("line-a\nline-b\nline-c\n");
  });

  it("skips the transcript copy when excludeTurns is true", async () => {
    const root = await makeStateRoot();
    const logger = makeLogger();
    const store = new ThreadStore(root, logger);
    const { threadId } = await seedParentThread(store, { transcript: "history\n" });
    const handler = createThreadForkHandler(store, logger);

    const resp = (await handler({ threadId, excludeTurns: true })) as { thread: { id: string } };
    const forkId = resp.thread.id;
    let forkExists = true;
    try {
      await stat(store.messagesPath(forkId));
    } catch {
      forkExists = false;
    }
    expect(forkExists).toBe(false);
  });

  it("inherits the parent's dynamicTools + mcpServersConfig when overrides are omitted", async () => {
    const root = await makeStateRoot();
    const logger = makeLogger();
    const store = new ThreadStore(root, logger);
    const parentTools = [
      { name: "openclaw_a", description: "tool A" },
      { name: "openclaw_b", description: "tool B" },
    ];
    const parentMcp = { openclaw: { stdio: { command: "openclaw" } } };
    const { threadId } = await seedParentThread(store, {
      dynamicTools: parentTools,
      dynamicToolsFingerprint: "fp-parent",
      mcpServersConfig: parentMcp,
    });
    const handler = createThreadForkHandler(store, logger);

    const resp = (await handler({ threadId })) as { thread: { id: string } };
    const forkMeta = await store.readMeta(resp.thread.id);
    expect(forkMeta?.dynamicTools).toEqual(parentTools);
    expect(forkMeta?.dynamicToolsFingerprint).toBe("fp-parent");
    expect(forkMeta?.mcpServersConfig).toEqual(parentMcp);
  });

  it("adopts override dynamicTools + dynamicToolsFingerprint + mcpServersConfig (bridge catalog-drift path)", async () => {
    const root = await makeStateRoot();
    const logger = makeLogger();
    const store = new ThreadStore(root, logger);
    const { threadId } = await seedParentThread(store, {
      dynamicTools: [{ name: "openclaw_old", description: "old tool" }],
      dynamicToolsFingerprint: "fp-old",
      mcpServersConfig: { old: { stdio: { command: "old" } } },
    });
    const handler = createThreadForkHandler(store, logger);

    const newTools = [
      { name: "openclaw_new_1", description: "new tool 1" },
      { name: "openclaw_new_2", description: "new tool 2" },
    ];
    const newMcp = { openclaw: { stdio: { command: "openclaw" } } };
    const resp = (await handler({
      threadId,
      dynamicTools: newTools,
      dynamicToolsFingerprint: "fp-new",
      mcpServersConfig: newMcp,
    })) as { thread: { id: string } };

    const forkMeta = await store.readMeta(resp.thread.id);
    expect(forkMeta?.dynamicTools).toEqual(newTools);
    expect(forkMeta?.dynamicToolsFingerprint).toBe("fp-new");
    expect(forkMeta?.mcpServersConfig).toEqual(newMcp);
  });

  it("filters non-object/non-string dynamicTools entries from the override", async () => {
    const root = await makeStateRoot();
    const logger = makeLogger();
    const store = new ThreadStore(root, logger);
    const { threadId } = await seedParentThread(store);
    const handler = createThreadForkHandler(store, logger);

    const resp = (await handler({
      threadId,
      dynamicTools: [
        { name: "openclaw_ok", description: "ok" },
        { name: 123, description: "bad-name" }, // not a string — should be dropped
        { name: "openclaw_no_desc" }, // missing description — dropped
        null, // dropped
        "not-an-object", // dropped
      ],
    })) as { thread: { id: string } };

    const forkMeta = await store.readMeta(resp.thread.id);
    expect(forkMeta?.dynamicTools).toEqual([{ name: "openclaw_ok", description: "ok" }]);
  });

  it("preserves transcript continuity AND applies new catalog (full catalog-drift round-trip)", async () => {
    const root = await makeStateRoot();
    const logger = makeLogger();
    const store = new ThreadStore(root, logger);
    const { threadId } = await seedParentThread(store, {
      dynamicTools: [{ name: "openclaw_stale", description: "" }],
      dynamicToolsFingerprint: "fp-stale",
      transcript: "user-turn\nassistant-turn\n",
    });
    const handler = createThreadForkHandler(store, logger);

    const resp = (await handler({
      threadId,
      dynamicTools: [{ name: "openclaw_fresh", description: "" }],
      dynamicToolsFingerprint: "fp-fresh",
    })) as { thread: { id: string; forkedFromId: string } };

    // Transcript carried forward.
    expect(await readFile(store.messagesPath(resp.thread.id), "utf8")).toBe(
      "user-turn\nassistant-turn\n",
    );
    // Catalog refreshed.
    const forkMeta = await store.readMeta(resp.thread.id);
    expect(forkMeta?.dynamicTools).toEqual([{ name: "openclaw_fresh", description: "" }]);
    expect(forkMeta?.dynamicToolsFingerprint).toBe("fp-fresh");
    // Parentage recorded.
    expect(resp.thread.forkedFromId).toBe(threadId);
  });

  it("throws an RpcError when the parent thread is missing", async () => {
    const root = await makeStateRoot();
    const logger = makeLogger();
    const store = new ThreadStore(root, logger);
    const handler = createThreadForkHandler(store, logger);

    await expect(handler({ threadId: "does-not-exist" })).rejects.toThrow(/not found/i);
  });
});
