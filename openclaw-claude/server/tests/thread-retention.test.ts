/**
 * Tests for `ThreadStore.pruneStaleThreads` — the retention sweep that keeps
 * `<stateRoot>/threads` from growing without bound. The important edge: a
 * thread whose meta.json is old but whose messages.jsonl was appended recently
 * is IN USE and must survive (the SDK appends to the transcript without
 * touching meta).
 */

import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadStore } from "../src/thread-store.js";

const tempDirs: string[] = [];
const DAY_MS = 86_400_000;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openclaw-thread-retention-"));
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

/** Back-date every file in a thread dir (and the dir itself) to `ageMs` ago. */
async function ageThread(store: ThreadStore, threadId: string, ageMs: number, files: string[]) {
  const when = new Date(Date.now() - ageMs);
  for (const file of files) {
    await utimes(path.join(store.threadDir(threadId), file), when, when);
  }
  await utimes(store.threadDir(threadId), when, when);
}

describe("ThreadStore.pruneStaleThreads", () => {
  it("deletes threads whose every file is older than maxAgeMs and keeps fresh ones", async () => {
    const root = await makeStateRoot();
    const store = new ThreadStore(root, makeLogger());
    const stale = await seedThread(store);
    const fresh = await seedThread(store);
    await ageThread(store, stale.id, 45 * DAY_MS, ["meta.json"]);

    const result = await store.pruneStaleThreads({ maxAgeMs: 30 * DAY_MS });

    expect(result).toEqual({ scanned: 2, pruned: 1, kept: 1, failed: 0 });
    expect(existsSync(store.threadDir(stale.id))).toBe(false);
    expect(existsSync(store.threadDir(fresh.id))).toBe(true);
  });

  it("keeps a thread with an old meta.json when its transcript was appended recently", async () => {
    const root = await makeStateRoot();
    const store = new ThreadStore(root, makeLogger());
    const active = await seedThread(store);
    await writeFile(store.messagesPath(active.id), '{"type":"user"}\n', "utf8");
    // Back-date meta + dir, but leave messages.jsonl at "now".
    await ageThread(store, active.id, 45 * DAY_MS, ["meta.json"]);

    const result = await store.pruneStaleThreads({ maxAgeMs: 30 * DAY_MS });

    expect(result).toEqual({ scanned: 1, pruned: 0, kept: 1, failed: 0 });
    expect(existsSync(store.threadDir(active.id))).toBe(true);
  });

  it("is a no-op when retention is disabled (maxAgeMs <= 0 or non-finite)", async () => {
    const root = await makeStateRoot();
    const store = new ThreadStore(root, makeLogger());
    const thread = await seedThread(store);
    await ageThread(store, thread.id, 400 * DAY_MS, ["meta.json"]);

    for (const maxAgeMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await store.pruneStaleThreads({ maxAgeMs });
      expect(result).toEqual({ scanned: 0, pruned: 0, kept: 0, failed: 0 });
    }
    expect(existsSync(store.threadDir(thread.id))).toBe(true);
  });

  it("returns zeros when the threads root does not exist yet", async () => {
    const root = await makeStateRoot();
    const store = new ThreadStore(path.join(root, "never-created"), makeLogger());
    const result = await store.pruneStaleThreads({ maxAgeMs: 30 * DAY_MS });
    expect(result).toEqual({ scanned: 0, pruned: 0, kept: 0, failed: 0 });
  });

  it("honours an injected `now` so callers can sweep deterministically", async () => {
    const root = await makeStateRoot();
    const store = new ThreadStore(root, makeLogger());
    const thread = await seedThread(store);
    // Pretend it is 31 days in the future: the freshly created thread is now stale.
    const result = await store.pruneStaleThreads({
      maxAgeMs: 30 * DAY_MS,
      now: Date.now() + 31 * DAY_MS,
    });
    expect(result.pruned).toBe(1);
    expect(existsSync(store.threadDir(thread.id))).toBe(false);
  });
});
