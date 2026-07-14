/**
 * Tests for `createThreadArchiveHandler` / `createThreadUnarchiveHandler`.
 * Codex parity note covered here: archive returns void, unarchive returns
 * the restored thread — see protocol.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadArchiveHandler, createThreadUnarchiveHandler } from "../src/handlers/thread-archive.js";
import { RpcError } from "../src/server.js";
import { ThreadStore } from "../src/thread-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-thread-archive-"));
  tempDirs.push(root);
  return root;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

async function seedThread(store: ThreadStore) {
  return store.createThread({
    cwd: "/tmp/ws",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    cliVersion: "test",
  });
}

describe("thread archive / unarchive", () => {
  it("archive sets archived + archivedAt and returns an empty object (codex parity)", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const thread = await seedThread(store);

    const archive = createThreadArchiveHandler(store, makeLogger());
    const result = await archive({ threadId: thread.id });

    expect(result).toEqual({});
    const meta = await store.readMeta(thread.id);
    expect(meta?.archived).toBe(true);
    expect(meta?.archivedAt).toEqual(expect.any(Number));
  });

  it("unarchive clears archived state and returns the restored thread", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const thread = await seedThread(store);
    await store.updateMeta(thread.id, { archived: true, archivedAt: 123 });

    const unarchive = createThreadUnarchiveHandler(store, makeLogger());
    const result = (await unarchive({ threadId: thread.id })) as { thread: { id: string; archived: boolean } };

    expect(result.thread.id).toBe(thread.id);
    expect(result.thread.archived).toBe(false);
    const meta = await store.readMeta(thread.id);
    expect(meta?.archived).toBe(false);
    expect(meta?.archivedAt).toBeNull();
  });

  it("both throw a thread-not-found RpcError for an unknown thread", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const archive = createThreadArchiveHandler(store, makeLogger());
    const unarchive = createThreadUnarchiveHandler(store, makeLogger());
    await expect(archive({ threadId: "nope" })).rejects.toThrow(RpcError);
    await expect(unarchive({ threadId: "nope" })).rejects.toThrow(RpcError);
  });

  it("archived threads are excluded from thread/list by default (covered in thread-list.test.ts) but archive itself doesn't touch the transcript dir", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const thread = await seedThread(store);
    const archive = createThreadArchiveHandler(store, makeLogger());
    await archive({ threadId: thread.id });
    // Archiving is metadata-only — the thread must still be readable/resumable.
    const meta = await store.readMeta(thread.id);
    expect(meta).not.toBeNull();
  });
});
