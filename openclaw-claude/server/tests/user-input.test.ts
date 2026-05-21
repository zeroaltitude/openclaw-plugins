import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildContentBlocks,
  ControllableUserInputQueue,
  makeSDKUserMessage,
} from "../src/user-input.js";

describe("buildContentBlocks", () => {
  it("translates text input into a text block", async () => {
    const blocks = await buildContentBlocks([{ type: "text", text: "hello" }]);
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("translates url-form image into base64 source when given a data URL", async () => {
    const blocks = await buildContentBlocks([
      { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
    expect(blocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
      },
    ]);
  });

  it("translates url-form image into url source when given a real URL", async () => {
    const blocks = await buildContentBlocks([
      { type: "image", url: "https://example.com/cat.png" },
    ]);
    expect(blocks).toEqual([
      {
        type: "image",
        source: { type: "url", url: "https://example.com/cat.png" },
      },
    ]);
  });

  it("reads localImage from disk and base64-encodes with mime from extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ucib-"));
    const filePath = join(dir, "tiny.png");
    const bytes = Buffer.from([1, 2, 3, 4]);
    await writeFile(filePath, bytes);
    const blocks = await buildContentBlocks([{ type: "localImage", path: filePath }]);
    expect(blocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
      },
    ]);
  });

  it("falls back to a text block when localImage file is missing", async () => {
    const blocks = await buildContentBlocks([
      { type: "localImage", path: "/nonexistent/path/x.png" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect((blocks[0] as { text: string }).text).toMatch(/image read failed/i);
  });

  it("guards against fully-empty input by emitting an empty text block", async () => {
    const blocks = await buildContentBlocks([]);
    expect(blocks).toEqual([{ type: "text", text: "" }]);
  });
});

describe("makeSDKUserMessage", () => {
  it("wraps content into the SDK's user-message shape", () => {
    const msg = makeSDKUserMessage([{ type: "text", text: "hi" }]);
    expect(msg.type).toBe("user");
    const message = msg.message as { role: string; content: unknown };
    expect(message.role).toBe("user");
    expect(message.content).toEqual([{ type: "text", text: "hi" }]);
    expect(msg.parent_tool_use_id).toBeNull();
    expect(typeof msg.uuid).toBe("string");
  });
});

describe("ControllableUserInputQueue", () => {
  it("yields buffered messages in FIFO order", async () => {
    const q = new ControllableUserInputQueue();
    q.push({ n: 1 });
    q.push({ n: 2 });
    q.close();
    const out: unknown[] = [];
    for await (const m of q.iterate()) out.push(m);
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("blocks until a message is pushed, then yields it", async () => {
    const q = new ControllableUserInputQueue();
    const got: unknown[] = [];
    const consumer = (async () => {
      for await (const m of q.iterate()) got.push(m);
    })();
    // No messages yet — give the consumer a tick so it's parked on the waiter.
    await new Promise((r) => setImmediate(r));
    q.push({ later: true });
    q.close();
    await consumer;
    expect(got).toEqual([{ later: true }]);
  });

  it("terminates iteration when closed with no pending messages", async () => {
    const q = new ControllableUserInputQueue();
    const consumer = (async () => {
      const out: unknown[] = [];
      for await (const m of q.iterate()) out.push(m);
      return out;
    })();
    q.close();
    expect(await consumer).toEqual([]);
  });

  it("drops pushes after close", async () => {
    const q = new ControllableUserInputQueue();
    q.close();
    q.push({ ignored: true });
    const out: unknown[] = [];
    for await (const m of q.iterate()) out.push(m);
    expect(out).toEqual([]);
  });

  it("isClosed flips after close", () => {
    const q = new ControllableUserInputQueue();
    expect(q.isClosed()).toBe(false);
    q.close();
    expect(q.isClosed()).toBe(true);
  });
});
