/**
 * Live behavior proof for `thread/compact/start` (bridge 0.7.0).
 *
 * Real everything between the JSON-RPC surface and Anthropic: spawns the
 * actual built bridge (dist/cli.js), which spawns the real Claude CLI via
 * @anthropic-ai/claude-agent-sdk using local credentials. No mocks of the
 * seam under test — this pins the one assumption unit tests cannot: that a
 * `/compact` user message sent through the SDK's streaming input actually
 * triggers CLI-native compaction and reports back via `compact_boundary` /
 * `compact_result`.
 *
 * Scenarios:
 *   1. thread/start + a short real turn (builds compactable history).
 *   2. A second short turn (same live attempt — exercises subprocess reuse).
 *   3. thread/compact/start → expects `thread/compact/completed` with
 *      compacted:true and pre-token accounting.
 *   4. A post-compaction turn — proves the thread resumes cleanly from the
 *      compacted transcript (the attempt was discarded by design).
 *
 * Run: pnpm tsx scripts/proof-thread-compact-live.ts   (or npx tsx ...)
 * Requires: `npm run build` first; local Claude credentials (~/.claude).
 * Uses claude-haiku-4-5 to keep the run cheap.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/cli.js only exports main(); the bin wrapper is what invokes it.
const CLI = path.join(__dirname, "..", "bin", "openclaw-claude-bridge.mjs");
const MODEL = "claude-haiku-4-5";
const TURN_TIMEOUT_MS = 180_000;
const COMPACT_TIMEOUT_MS = 300_000;

type Json = Record<string, unknown>;

class BridgeHarness {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationWaiters: Array<{
    match: (method: string, params: Json) => boolean;
    resolve: (v: { method: string; params: Json }) => void;
  }> = [];
  readonly notifications: Array<{ method: string; params: Json }> = [];
  private buffer = "";

  constructor(stateRoot: string) {
    this.child = spawn("node", [CLI], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        OPENCLAW_CLAUDE_BRIDGE_STATE_ROOT: stateRoot,
        OPENCLAW_CLAUDE_BRIDGE_ALLOW_ALL: "1",
      },
    });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg: Json;
        try {
          msg = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        this.dispatch(msg);
      }
    });
  }

  private dispatch(msg: Json): void {
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }
    if (typeof msg.method === "string" && msg.id === undefined) {
      const params = (msg.params ?? {}) as Json;
      const record = { method: msg.method, params };
      this.notifications.push(record);
      for (let i = this.notificationWaiters.length - 1; i >= 0; i--) {
        const waiter = this.notificationWaiters[i]!;
        if (waiter.match(msg.method, params)) {
          this.notificationWaiters.splice(i, 1);
          waiter.resolve(record);
        }
      }
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  waitForNotification(
    match: (method: string, params: Json) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<{ method: string; params: Json }> {
    const already = this.notifications.find((n) => match(n.method, n.params));
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
        timeoutMs,
      );
      this.notificationWaiters.push({
        match,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
  }

  stop(): void {
    this.child.stdin!.end();
    this.child.kill("SIGTERM");
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function runTurn(bridge: BridgeHarness, threadId: string, text: string): Promise<Json> {
  const resp = (await bridge.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  })) as { turn: { id: string } };
  const turnId = resp.turn.id;
  const completed = await bridge.waitForNotification(
    (method, params) =>
      method === "turn/completed" && (params.turn as Json | undefined)?.id === turnId,
    TURN_TIMEOUT_MS,
    `turn/completed for ${turnId}`,
  );
  return completed.params.turn as Json;
}

async function main(): Promise<void> {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "bridge-compact-proof-"));
  const bridge = new BridgeHarness(stateRoot);
  try {
    await bridge.request("initialize", { clientInfo: { name: "compact-proof", version: "0" } });

    const startResp = (await bridge.request("thread/start", {
      model: MODEL,
      cwd: stateRoot,
      approvalPolicy: "never",
    })) as { thread: { id: string } };
    const threadId = startResp.thread.id;
    console.log(`[proof] thread started: ${threadId}`);

    // Scenario 1+2: real history to compact, across a reused live attempt.
    const turn1 = await runTurn(
      bridge,
      threadId,
      "Remember this codeword: PELICAN-42. Reply with just: noted",
    );
    assert(turn1.status === "completed", `turn 1 completed (got ${String(turn1.status)})`);
    console.log("[proof] turn 1 completed");
    const turn2 = await runTurn(bridge, threadId, "Reply with just the codeword I gave you.");
    assert(turn2.status === "completed", `turn 2 completed (got ${String(turn2.status)})`);
    console.log("[proof] turn 2 completed");

    // Scenario 3: native compaction.
    const compactResp = (await bridge.request("thread/compact/start", { threadId })) as {
      turn: { id: string; status: string };
    };
    assert(
      compactResp.turn.status === "inProgress",
      `compact start returns inProgress turn (got ${compactResp.turn.status})`,
    );
    const compactTurnId = compactResp.turn.id;
    console.log(`[proof] compaction started: turn ${compactTurnId}`);
    const completed = await bridge.waitForNotification(
      (method, params) => method === "thread/compact/completed" && params.threadId === threadId,
      COMPACT_TIMEOUT_MS,
      "thread/compact/completed",
    );
    const payload = completed.params;
    console.log(`[proof] thread/compact/completed: ${JSON.stringify(payload)}`);
    assert(payload.compacted === true, `compacted === true (got ${JSON.stringify(payload)})`);
    assert(payload.turnId === compactTurnId, "completion is for the compaction turn");
    assert(
      typeof payload.preTokens === "number" && payload.preTokens > 0,
      `preTokens accounting present (got ${String(payload.preTokens)})`,
    );
    const boundary = bridge.notifications.find(
      (n) => n.method === "thread/compact/boundary" && n.params.threadId === threadId,
    );
    assert(boundary, "thread/compact/boundary notification observed");

    // Scenario 4: the thread survives compaction (fresh resume of the
    // compacted transcript — the attempt was deliberately discarded).
    const turn3 = await runTurn(bridge, threadId, "Reply with just: alive");
    assert(turn3.status === "completed", `post-compaction turn completed (got ${String(turn3.status)})`);
    console.log("[proof] post-compaction turn completed");

    console.log("All runtime assertions passed.");
  } finally {
    bridge.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
