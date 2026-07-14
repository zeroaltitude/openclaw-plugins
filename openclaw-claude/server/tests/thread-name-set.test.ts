/**
 * Tests for `createThreadSetNameHandler` — the server's thread/name/set RPC.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadSetNameHandler } from "../src/handlers/thread-name-set.js";
import { RpcError } from "../src/server.js";
import { ThreadStore } from "../src/thread-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-thread-name-set-"));
  tempDirs.push(root);
  return root;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

describe("createThreadSetNameHandler", () => {
  it("persists the name onto thread metadata", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const thread = await store.createThread({
      cwd: "/tmp/ws",
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      cliVersion: "test",
    });

    const handler = createThreadSetNameHandler(store, makeLogger());
    await handler({ threadId: thread.id, name: "Debugging session" });

    const updated = await store.readMeta(thread.id);
    expect(updated?.name).toBe("Debugging session");
  });

  it("rejects params missing threadId or name", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const handler = createThreadSetNameHandler(store, makeLogger());
    await expect(handler({ threadId: "x" })).rejects.toThrow(RpcError);
    await expect(handler({ name: "x" })).rejects.toThrow(RpcError);
  });

  it("throws a thread-not-found RpcError for an unknown thread", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const handler = createThreadSetNameHandler(store, makeLogger());
    await expect(handler({ threadId: "does-not-exist", name: "x" })).rejects.toThrow(RpcError);
  });
});
