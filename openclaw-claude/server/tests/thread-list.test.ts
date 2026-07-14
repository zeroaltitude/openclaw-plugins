/**
 * Tests for `createThreadListHandler` — the server's thread/list RPC.
 * Covers: default view excludes archived, archived:true flips to
 * archived-only, sort direction/key, pagination cursor, and live-status
 * cross-reference against AttemptRegistry.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttemptRegistry } from "../src/attempt-registry.js";
import { createThreadListHandler } from "../src/handlers/thread-list.js";
import { ThreadStore } from "../src/thread-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-thread-list-"));
  tempDirs.push(root);
  return root;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

async function seedThread(store: ThreadStore, overrides: { cwd?: string; model?: string } = {}) {
  return store.createThread({
    cwd: overrides.cwd ?? "/tmp/ws",
    model: overrides.model ?? "claude-sonnet-4-6",
    modelProvider: "anthropic",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    cliVersion: "test",
  });
}

describe("createThreadListHandler", () => {
  it("returns non-archived threads by default, newest updated first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const store = new ThreadStore(await makeStateRoot(), makeLogger());
      const a = await seedThread(store, { cwd: "/tmp/a" });
      vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
      const b = await seedThread(store, { cwd: "/tmp/b" });

      const handler = createThreadListHandler(store, new AttemptRegistry(), makeLogger());
      const result = (await handler(undefined)) as { data: Array<{ id: string; cwd: string }> };

      expect(result.data.map((t) => t.id)).toEqual([b.id, a.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides archived threads by default and includes them when archived:true", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const active = await seedThread(store, { cwd: "/tmp/active" });
    const archived = await seedThread(store, { cwd: "/tmp/archived" });
    await store.updateMeta(archived.id, { archived: true, archivedAt: 12345 });

    const handler = createThreadListHandler(store, new AttemptRegistry(), makeLogger());

    const defaultView = (await handler(undefined)) as { data: Array<{ id: string }> };
    expect(defaultView.data.map((t) => t.id)).toEqual([active.id]);

    const archivedView = (await handler({ archived: true })) as { data: Array<{ id: string }> };
    expect(archivedView.data.map((t) => t.id)).toEqual([archived.id]);
  });

  it("paginates via cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const store = new ThreadStore(await makeStateRoot(), makeLogger());
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const t = await seedThread(store, { cwd: `/tmp/t${i}` });
        ids.push(t.id);
        vi.setSystemTime(new Date(Date.now() + 5_000));
      }
      // newest first: [t2, t1, t0]
      const expectedOrder = [ids[2], ids[1], ids[0]];

      const handler = createThreadListHandler(store, new AttemptRegistry(), makeLogger());
      const page1 = (await handler({ limit: 2 })) as {
        data: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page1.data.map((t) => t.id)).toEqual(expectedOrder.slice(0, 2));
      expect(page1.nextCursor).toBe(expectedOrder[1]);

      const page2 = (await handler({ limit: 2, cursor: page1.nextCursor })) as {
        data: Array<{ id: string }>;
        nextCursor: string | null;
      };
      expect(page2.data.map((t) => t.id)).toEqual(expectedOrder.slice(2));
      expect(page2.nextCursor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports active status for threads with a live (non-closed) attempt entry", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const t = await seedThread(store);
    const registry = new AttemptRegistry();
    registry.set(t.id, {
      threadId: t.id,
      fingerprint: "x",
      inputQueue: { close: vi.fn() } as never,
      abortController: new AbortController(),
      liveTurnRef: { turn: {} as never },
      currentHandler: null,
      currentReject: null,
      closed: false,
      createdAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
    });

    const handler = createThreadListHandler(store, registry, makeLogger());
    const result = (await handler(undefined)) as { data: Array<{ id: string; status: { type: string } }> };
    expect(result.data[0]?.status).toEqual({ type: "active" });
  });

  it("filters by searchTerm against name and cwd", async () => {
    const store = new ThreadStore(await makeStateRoot(), makeLogger());
    const match = await seedThread(store, { cwd: "/home/eddie/projects/openclaw" });
    await seedThread(store, { cwd: "/tmp/unrelated" });

    const handler = createThreadListHandler(store, new AttemptRegistry(), makeLogger());
    const result = (await handler({ searchTerm: "openclaw" })) as { data: Array<{ id: string }> };
    expect(result.data.map((t) => t.id)).toEqual([match.id]);
  });
});
