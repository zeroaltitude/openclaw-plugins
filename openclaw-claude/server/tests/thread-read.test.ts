/**
 * Tests for `createThreadReadHandler`. Entry shapes here are modeled on real
 * messages.jsonl content inspected on disk (user/assistant entries with
 * Anthropic content blocks, interleaved with OpenClaw harness bookkeeping
 * entries like queue-operation/ai-title/mode) — see the handler's module
 * doc comment for the v1 scope note.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadReadHandler } from "../src/handlers/thread-read.js";
import { RpcError } from "../src/server.js";
import { ThreadStore } from "../src/thread-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-thread-read-"));
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

describe("createThreadReadHandler", () => {
  it("reconstructs text + tool_use items into one synthetic completed turn, skipping harness bookkeeping entries", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const thread = await seedThread(store);

    const lines = [
      { type: "queue-operation", operation: "enqueue", sessionId: "x" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "how does auth work?" }] } },
      { type: "ai-title", title: "Auth question" },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me check" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "src/auth.ts" } },
          ],
        },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Auth is handled in src/auth.ts." }] },
      },
      { type: "mode", mode: "default" },
    ];
    await writeFile(store.messagesPath(thread.id), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const handler = createThreadReadHandler(store, makeLogger());
    const result = (await handler({ threadId: thread.id })) as {
      thread: { turns: Array<{ status: string; items: Array<{ type: string; text: string; name: string | null }> }> };
    };

    expect(result.thread.turns).toHaveLength(1);
    const turn = result.thread.turns[0];
    expect(turn.status).toBe("completed");
    expect(turn.items.map((i) => i.type)).toEqual(["userMessage", "toolCall", "agentMessage"]);
    expect(turn.items[0].text).toBe("how does auth work?");
    expect(turn.items[1].name).toBe("Read");
    expect(turn.items[2].text).toBe("Auth is handled in src/auth.ts.");
  });

  it("returns no turns for a thread with no transcript yet", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const thread = await seedThread(store);
    const handler = createThreadReadHandler(store, makeLogger());
    const result = (await handler({ threadId: thread.id })) as { thread: { turns: unknown[] } };
    expect(result.thread.turns).toEqual([]);
  });

  it("omits turns when includeTurns is false", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const thread = await seedThread(store);
    await writeFile(
      store.messagesPath(thread.id),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n",
      "utf8",
    );
    const handler = createThreadReadHandler(store, makeLogger());
    const result = (await handler({ threadId: thread.id, includeTurns: false })) as { thread: { turns: unknown[] } };
    expect(result.thread.turns).toEqual([]);
  });

  it("throws a thread-not-found RpcError for an unknown thread", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const handler = createThreadReadHandler(store, makeLogger());
    await expect(handler({ threadId: "nope" })).rejects.toThrow(RpcError);
  });
});
