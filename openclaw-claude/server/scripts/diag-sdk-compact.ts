/**
 * Diagnostic: drive the SDK directly with streaming input, send a short turn
 * then `/compact`, and dump every message (type/subtype/compact fields) plus
 * every sessionStore method call — to establish exactly how manual compaction
 * is reported and persisted on the installed SDK version.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stateRoot = mkdtempSync(path.join(tmpdir(), "sdk-compact-diag-"));
const transcript = path.join(stateRoot, "messages.jsonl");

const storeCalls: string[] = [];
const sessionStore = new Proxy(
  {
    async append(_key: unknown, entries: Array<Record<string, unknown>>) {
      storeCalls.push(`append x${entries.length}: ${entries.map((e) => String(e.type)).join(",")}`);
      const text = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fs.appendFile(transcript, text, "utf8");
    },
    async read() {
      storeCalls.push("read");
      try {
        const content = await fs.readFile(transcript, "utf8");
        return content;
      } catch {
        return "";
      }
    },
  },
  {
    get(target, prop) {
      if (typeof prop === "string" && !(prop in target)) {
        storeCalls.push(`GET unknown method: ${prop}`);
      }
      return (target as Record<string | symbol, unknown>)[prop];
    },
  },
);

async function* input() {
  yield {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Reply with just: ok" }] },
    parent_tool_use_id: null,
    session_id: "diag",
  };
  // Wait for first result before /compact — handled by the pump below via a gate.
  await gate.promise;
  yield {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "/compact" }] },
    parent_tool_use_id: null,
    session_id: "diag",
  };
}

const gate: { promise: Promise<void>; open: () => void } = (() => {
  let open = () => {};
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
})();

const stream = query({
  prompt: input() as never,
  options: {
    model: "claude-haiku-4-5",
    cwd: stateRoot,
    permissionMode: "bypassPermissions",
    sessionStore: sessionStore as never,
    sessionId: "1f9e8d7c-6b5a-4321-9876-543210fedcba",
    includePartialMessages: false,
  } as never,
});

let resultCount = 0;
const timer = setTimeout(() => {
  console.log("[diag] TIMEOUT waiting for messages");
  dump();
  process.exit(2);
}, 240_000);

function dump() {
  console.log("=== store calls ===");
  for (const c of storeCalls) console.log("  " + c);
}

for await (const msg of stream as AsyncIterable<Record<string, unknown>>) {
  const compactBits = JSON.stringify({
    compact_metadata: msg.compact_metadata,
    compact_result: msg.compact_result,
    compact_error: msg.compact_error,
    status: msg.status,
  });
  console.log(`[msg] type=${String(msg.type)} subtype=${String(msg.subtype ?? "")} ${compactBits}`);
  if (msg.type === "result") {
    resultCount += 1;
    if (resultCount === 1) {
      gate.open();
    } else {
      break;
    }
  }
  if (
    msg.type === "system" &&
    msg.subtype === "status" &&
    (msg.compact_result === "success" || msg.compact_result === "failed")
  ) {
    // Give any trailing messages a moment, then stop.
    setTimeout(() => {
      clearTimeout(timer);
      dump();
      console.log("[diag] transcript after compaction:");
      fs.readFile(transcript, "utf8").then((content) => {
        for (const line of content.split("\n").filter(Boolean)) {
          const e = JSON.parse(line) as Record<string, unknown>;
          console.log(
            `  [record] type=${String(e.type)} subtype=${String(e.subtype ?? "")} isCompactSummary=${String((e as { isCompactSummary?: unknown }).isCompactSummary ?? "")}`,
          );
        }
        process.exit(0);
      });
    }, 3000);
  }
}
clearTimeout(timer);
dump();
