import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IMAGE_MAX_BYTES,
  ANTHROPIC_IMAGES_PER_REQUEST,
  base64DecodedByteLength,
  sanitizeAnthropicImagePayload,
  type SanitizableContentBlock,
} from "../src/image-payload-sanitizer.js";

function base64OfBytes(n: number): string {
  // Use a deterministic single character so the byte length lands exactly
  // where we want it (no padding-rounding surprises). 'A' decodes to one
  // byte per 4 chars after padding accounting.
  // Easier: build a Buffer of `n` zero bytes and base64-encode it.
  return Buffer.alloc(n).toString("base64");
}

describe("base64DecodedByteLength", () => {
  it("counts known small payloads exactly", () => {
    expect(base64DecodedByteLength("")).toBe(0);
    expect(base64DecodedByteLength(Buffer.from("hello").toString("base64"))).toBe(5);
    expect(base64DecodedByteLength(Buffer.from("hi").toString("base64"))).toBe(2);
  });

  it("matches actual decoded length for various sizes", () => {
    for (const n of [1, 2, 3, 4, 100, 1024, 1024 * 1024]) {
      const data = Buffer.alloc(n).toString("base64");
      expect(base64DecodedByteLength(data)).toBe(n);
    }
  });

  it("tolerates whitespace inside base64 input", () => {
    const data = Buffer.alloc(10).toString("base64");
    const interleaved = data.match(/.{1,2}/g)?.join("\n") ?? data;
    expect(base64DecodedByteLength(interleaved)).toBe(10);
  });
});

describe("sanitizeAnthropicImagePayload", () => {
  it("passes through text blocks unchanged", () => {
    const blocks: SanitizableContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.blocks).toEqual(blocks);
    expect(out.notes).toEqual([]);
    expect(out.droppedImageCount).toBe(0);
  });

  it("accepts a small image with a supported media type", () => {
    const blocks: SanitizableContentBlock[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64OfBytes(1000) },
      },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.droppedImageCount).toBe(0);
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]?.type).toBe("image");
  });

  it("rejects an image with an unsupported media type", () => {
    const blocks: SanitizableContentBlock[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/bmp", data: base64OfBytes(100) },
      },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.droppedImageCount).toBe(1);
    expect(out.blocks[0]?.type).toBe("text");
    expect((out.blocks[0] as { text: string }).text).toContain("image/bmp");
  });

  it("rejects an oversize base64 image", () => {
    const blocks: SanitizableContentBlock[] = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: base64OfBytes(ANTHROPIC_IMAGE_MAX_BYTES + 1),
        },
      },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.droppedImageCount).toBe(1);
    expect(out.notes[0]).toContain("exceeds Anthropic limit");
  });

  it("accepts http(s) image urls without inspecting content", () => {
    const blocks: SanitizableContentBlock[] = [
      { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
      { type: "image", source: { type: "url", url: "http://example.com/dog.png" } },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.droppedImageCount).toBe(0);
    expect(out.blocks).toHaveLength(2);
  });

  it("rejects unsupported url schemes (ftp, file)", () => {
    const blocks: SanitizableContentBlock[] = [
      { type: "image", source: { type: "url", url: "ftp://example.com/x.png" } },
      { type: "image", source: { type: "url", url: "file:///etc/passwd" } },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.droppedImageCount).toBe(2);
    expect(out.notes[0]).toContain("scheme");
  });

  it("validates data: URLs that survive as url-source blocks", () => {
    const good = `data:image/png;base64,${base64OfBytes(100)}`;
    const badType = `data:image/bmp;base64,${base64OfBytes(100)}`;
    const oversize = `data:image/png;base64,${base64OfBytes(ANTHROPIC_IMAGE_MAX_BYTES + 10)}`;
    const malformed = "data:image/png;some-bad-encoding,xyz";
    const blocks: SanitizableContentBlock[] = [
      { type: "image", source: { type: "url", url: good } },
      { type: "image", source: { type: "url", url: badType } },
      { type: "image", source: { type: "url", url: oversize } },
      { type: "image", source: { type: "url", url: malformed } },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.droppedImageCount).toBe(3);
    expect(out.notes.some((n) => n.includes("image/bmp"))).toBe(true);
    expect(out.notes.some((n) => n.includes("exceeds Anthropic limit"))).toBe(true);
    expect(out.notes.some((n) => n.includes("malformed data: URL"))).toBe(true);
  });

  it("caps total image count at ANTHROPIC_IMAGES_PER_REQUEST", () => {
    const blocks: SanitizableContentBlock[] = Array.from(
      { length: ANTHROPIC_IMAGES_PER_REQUEST + 3 },
      () => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: base64OfBytes(10) },
      }),
    );
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.droppedImageCount).toBe(3);
    expect(out.blocks.filter((b) => b.type === "image")).toHaveLength(ANTHROPIC_IMAGES_PER_REQUEST);
    expect(out.notes.every((n) => n.includes("100 images per request"))).toBe(true);
  });

  it("preserves text/image interleaving order when replacing", () => {
    const blocks: SanitizableContentBlock[] = [
      { type: "text", text: "first" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/bmp", data: base64OfBytes(10) },
      },
      { type: "text", text: "second" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64OfBytes(10) },
      },
    ];
    const out = sanitizeAnthropicImagePayload(blocks);
    expect(out.blocks).toHaveLength(4);
    expect(out.blocks[0]).toEqual({ type: "text", text: "first" });
    expect(out.blocks[1]?.type).toBe("text"); // replaced
    expect((out.blocks[1] as { text: string }).text).toContain("[image dropped:");
    expect(out.blocks[2]).toEqual({ type: "text", text: "second" });
    expect(out.blocks[3]?.type).toBe("image"); // kept
  });
});
