/**
 * Pre-flight validation of Anthropic image content blocks before they hit
 * the Claude Agent SDK. Mirrors the codex app-server's
 * image-payload-sanitizer pattern.
 *
 * Anthropic's API constraints (per docs as of 2026-05):
 *   - allowed media types: image/jpeg, image/png, image/gif, image/webp
 *   - max image size: 5 MB per image
 *   - max images per request: 100
 *
 * Without this gate, invalid payloads surface as opaque Anthropic 400s
 * mid-turn. The sanitizer replaces offending image blocks with a text
 * note so the turn still progresses with the rest of the content, and
 * the user sees WHY the image was dropped.
 *
 * Pure functions; no I/O. Tested in tests/image-payload-sanitizer.test.ts.
 */

export const ANTHROPIC_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const ANTHROPIC_IMAGES_PER_REQUEST = 100;

export const ANTHROPIC_ALLOWED_IMAGE_MEDIA_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type SanitizableContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } };

export type SanitizeResult = {
  blocks: SanitizableContentBlock[];
  /** Notes describing dropped/rewritten payloads, in the order they happened. */
  notes: string[];
  /** Number of image blocks dropped or replaced. */
  droppedImageCount: number;
};

/**
 * Walk content blocks, validate any image payloads, replace invalid ones
 * with a `text` note. Non-image blocks pass through unchanged. The final
 * output is order-preserving so text/image interleaving stays intact.
 *
 * Validation rules:
 *   - base64: media_type must be in ANTHROPIC_ALLOWED_IMAGE_MEDIA_TYPES;
 *     decoded byte length must not exceed ANTHROPIC_IMAGE_MAX_BYTES.
 *   - url: must be http(s) or data:; obvious data: URIs that exceed the
 *     size cap once decoded are replaced.
 *   - Total image count across the input is capped at
 *     ANTHROPIC_IMAGES_PER_REQUEST; excess images are dropped at the tail.
 */
export function sanitizeAnthropicImagePayload(
  blocks: readonly SanitizableContentBlock[],
): SanitizeResult {
  const out: SanitizableContentBlock[] = [];
  const notes: string[] = [];
  let droppedImageCount = 0;
  let acceptedImageCount = 0;

  for (const block of blocks) {
    if (block.type !== "image") {
      out.push(block);
      continue;
    }
    if (acceptedImageCount >= ANTHROPIC_IMAGES_PER_REQUEST) {
      droppedImageCount += 1;
      const note = `[image dropped: exceeds Anthropic max of ${ANTHROPIC_IMAGES_PER_REQUEST} images per request]`;
      notes.push(note);
      out.push({ type: "text", text: note });
      continue;
    }
    const validation = validateImageBlock(block);
    if (validation.ok) {
      out.push(block);
      acceptedImageCount += 1;
      continue;
    }
    droppedImageCount += 1;
    notes.push(validation.reason);
    out.push({ type: "text", text: `[image dropped: ${validation.reason}]` });
  }

  return { blocks: out, notes, droppedImageCount };
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

function validateImageBlock(
  block: Extract<SanitizableContentBlock, { type: "image" }>,
): ValidationResult {
  const source = block.source;
  if (source.type === "base64") {
    if (!ANTHROPIC_ALLOWED_IMAGE_MEDIA_TYPES.has(source.media_type)) {
      return {
        ok: false,
        reason: `unsupported media_type "${source.media_type}"; allowed: ${[...ANTHROPIC_ALLOWED_IMAGE_MEDIA_TYPES].join(", ")}`,
      };
    }
    const bytes = base64DecodedByteLength(source.data);
    if (bytes > ANTHROPIC_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        reason: `payload ${formatBytes(bytes)} exceeds Anthropic limit ${formatBytes(ANTHROPIC_IMAGE_MAX_BYTES)}`,
      };
    }
    return { ok: true };
  }
  // url branch
  const url = source.url;
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "image url is empty" };
  }
  const trimmed = url.trim();
  if (trimmed.startsWith("data:")) {
    // A data: URL that survived buildContentBlocks's split (rare). Decode
    // and validate the embedded base64 the same way as a base64 source.
    const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return { ok: false, reason: "malformed data: URL (expected base64 encoding)" };
    }
    const mediaType = match[1] ?? "";
    const data = match[2] ?? "";
    if (!ANTHROPIC_ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType)) {
      return {
        ok: false,
        reason: `unsupported media_type "${mediaType}" in data: URL`,
      };
    }
    const bytes = base64DecodedByteLength(data);
    if (bytes > ANTHROPIC_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        reason: `data: URL payload ${formatBytes(bytes)} exceeds Anthropic limit ${formatBytes(ANTHROPIC_IMAGE_MAX_BYTES)}`,
      };
    }
    return { ok: true };
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      reason: `unsupported image url scheme; must be http(s) or data:`,
    };
  }
  return { ok: true };
}

/**
 * Decode-free base64 byte-length calculation. Counts trailing '=' padding
 * to subtract dropped bytes. Whitespace and invalid characters are tolerated
 * by counting only base64 alphabet characters.
 */
export function base64DecodedByteLength(data: string): number {
  let alphabetCount = 0;
  let paddingCount = 0;
  for (let i = 0; i < data.length; i += 1) {
    const ch = data.charCodeAt(i);
    // A-Z 65-90, a-z 97-122, 0-9 48-57, '+' 43, '/' 47, '-' 45 (url-safe), '_' 95 (url-safe)
    const isAlphabet =
      (ch >= 65 && ch <= 90) ||
      (ch >= 97 && ch <= 122) ||
      (ch >= 48 && ch <= 57) ||
      ch === 43 ||
      ch === 47 ||
      ch === 45 ||
      ch === 95;
    if (isAlphabet) {
      alphabetCount += 1;
    } else if (ch === 61) {
      // '='
      paddingCount += 1;
    }
    // Anything else (whitespace, garbage) is ignored — same as the
    // permissive decode that the SDK would apply.
  }
  const groups = Math.floor((alphabetCount + paddingCount) / 4);
  const bytes = groups * 3 - paddingCount;
  return bytes < 0 ? 0 : bytes;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
