/**
 * Translates codex's `UserInput[]` into Anthropic content blocks and provides
 * a controllable async-iterable user-input queue that the turn runner feeds
 * into `query({prompt: …})`.
 *
 * `ControllableUserInputQueue` is what makes `turn/steer` possible: the
 * runner pushes the initial message, hands the iterable to the SDK, and
 * keeps a reference. When `turn/steer` arrives we push a new message into
 * the same queue and the SDK consumes it as the next user turn within the
 * same logical OpenClaw turn.
 *
 * The Anthropic API doesn't support true mid-generation injection — the
 * steered message lands after the current assistant response finishes,
 * which matches codex's documented semantics ("queued steer message").
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { sanitizeAnthropicImagePayload, type SanitizableContentBlock } from "./image-payload-sanitizer.js";
import type { UserInput } from "./protocol.js";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource };

type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export async function buildContentBlocks(input: UserInput[]): Promise<AnthropicContentBlock[]> {
  const blocks: AnthropicContentBlock[] = [];
  for (const u of input) {
    if (u.type === "text" && typeof u.text === "string") {
      blocks.push({ type: "text", text: u.text });
    } else if (u.type === "image" && typeof u.url === "string") {
      // Data URLs collapse to base64 source so we don't need a network fetch
      // mid-turn; the SDK / Anthropic API accepts both data and http URLs.
      const dataMatch = u.url.match(/^data:([^;]+);base64,(.+)$/);
      if (dataMatch) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: dataMatch[1] ?? "image/png",
            data: dataMatch[2] ?? "",
          },
        });
      } else {
        blocks.push({ type: "image", source: { type: "url", url: u.url } });
      }
    } else if (u.type === "localImage" && typeof u.path === "string") {
      try {
        const data = await fs.readFile(u.path);
        const ext = path.extname(u.path).toLowerCase();
        const mediaType = MIME_BY_EXT[ext] ?? "image/png";
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        blocks.push({ type: "text", text: `[image read failed: ${u.path} — ${msg}]` });
      }
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  // Pre-flight: drop image payloads that would trigger an opaque 400 from
  // Anthropic (oversize, wrong media type, malformed data: URL, or count
  // exceeding 100 per request). The dropped blocks are replaced inline
  // with a text note so the rest of the turn still progresses.
  const sanitized = sanitizeAnthropicImagePayload(blocks as SanitizableContentBlock[]);
  return sanitized.blocks as AnthropicContentBlock[];
}

export function makeSDKUserMessage(content: AnthropicContentBlock[]): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
}

/**
 * A controllable async iterable: we yield messages from a FIFO queue,
 * blocking when the queue is empty until either a new message is pushed
 * or the queue is closed.
 *
 * The runner holds a reference to this and uses `push()` from the
 * turn/steer handler. `close()` is called when the turn terminates so the
 * SDK's iteration ends cleanly.
 */
export class ControllableUserInputQueue {
  private readonly buffer: unknown[] = [];
  private waiter: ((msg: unknown | null) => void) | null = null;
  private closed = false;

  push(msg: unknown): void {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(msg);
    } else {
      this.buffer.push(msg);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  async *iterate(): AsyncGenerator<unknown, void, void> {
    while (true) {
      if (this.buffer.length > 0) {
        const next = this.buffer.shift();
        if (next !== undefined) yield next;
        continue;
      }
      if (this.closed) return;
      const msg = await new Promise<unknown | null>((resolve) => {
        this.waiter = resolve;
      });
      if (msg === null) return;
      yield msg;
    }
  }
}

/**
 * Single-shot iterable used when the runner doesn't need to support
 * `turn/steer` (e.g. side-channel calls). The new turn flow uses
 * `ControllableUserInputQueue` instead so a steer can arrive later.
 */
export async function buildSingleUserMessageIterable(
  input: UserInput[],
): Promise<AsyncIterable<unknown>> {
  const content = await buildContentBlocks(input);
  async function* gen(): AsyncGenerator<unknown, void, void> {
    yield makeSDKUserMessage(content);
  }
  return gen();
}
