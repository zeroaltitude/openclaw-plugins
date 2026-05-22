/**
 * Anthropic rate-limit parsing and formatting.
 *
 * Mirrors the codex/app-server/rate-limits.ts pattern at a smaller scope:
 * inspect SDK errors for 429 metadata and surface a structured state that
 * the turn runner can fold into the user-visible error message.
 *
 * Anthropic exposes rate limits via response headers, regardless of
 * whether the request succeeded. Headers we care about:
 *   - anthropic-ratelimit-requests-limit / -remaining / -reset
 *   - anthropic-ratelimit-tokens-limit / -remaining / -reset
 *   - anthropic-ratelimit-input-tokens-limit / -remaining / -reset
 *   - anthropic-ratelimit-output-tokens-limit / -remaining / -reset
 *   - retry-after (seconds OR HTTP date — present on 429s)
 *
 * The Claude Agent SDK wraps the underlying Anthropic SDK errors. Both
 * forms expose `status`, `message`, and `headers` (raw headers map) on
 * the thrown error, so we parse defensively without depending on a
 * particular SDK error class.
 */

export type AnthropicRateLimitBucket = {
  kind: "requests" | "tokens" | "input-tokens" | "output-tokens";
  limit?: number;
  remaining?: number;
  resetAt?: string;
};

export type AnthropicRateLimitState = {
  status?: number;
  retryAfterSeconds?: number;
  retryAfterDate?: string;
  buckets: AnthropicRateLimitBucket[];
  /** Raw message from the SDK error, if any. */
  rawMessage?: string;
};

export function parseAnthropicRateLimitError(error: unknown): AnthropicRateLimitState | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const err = error as Record<string, unknown>;
  const status = readNumber(err.status);
  const headers = extractHeaders(err);

  // Without 429 status AND without a populated headers map, there's no
  // rate-limit context worth surfacing. Codex's rate-limits.ts uses the
  // same "headers present" gate to keep parsing scoped.
  if (!headers && status !== 429) {
    return null;
  }

  const buckets = headers ? parseBuckets(headers) : [];
  const retryAfter = headers ? parseRetryAfter(headers["retry-after"]) : undefined;

  if (status !== 429 && buckets.length === 0 && !retryAfter) {
    return null;
  }

  const state: AnthropicRateLimitState = {
    buckets,
    rawMessage: typeof err.message === "string" ? err.message : undefined,
  };
  if (status !== undefined) state.status = status;
  if (retryAfter?.seconds !== undefined) state.retryAfterSeconds = retryAfter.seconds;
  if (retryAfter?.date !== undefined) state.retryAfterDate = retryAfter.date;
  return state;
}

export function formatRateLimitMessage(state: AnthropicRateLimitState): string {
  const lines: string[] = [];
  if (state.status === 429) {
    lines.push("Anthropic rate limit hit (HTTP 429).");
  } else if (state.buckets.length > 0) {
    lines.push("Anthropic rate-limit metadata:");
  }
  if (state.retryAfterSeconds !== undefined) {
    lines.push(`Retry after ~${state.retryAfterSeconds}s.`);
  } else if (state.retryAfterDate) {
    lines.push(`Retry after ${state.retryAfterDate}.`);
  }
  for (const bucket of state.buckets) {
    const remaining = bucket.remaining ?? "?";
    const limit = bucket.limit ?? "?";
    const reset = bucket.resetAt ? ` (resets ${bucket.resetAt})` : "";
    lines.push(`  ${bucket.kind}: ${remaining}/${limit}${reset}`);
  }
  if (state.rawMessage) {
    lines.push(`Underlying error: ${state.rawMessage}`);
  }
  return lines.join("\n");
}

// ── internal parsing helpers ────────────────────────────────────────────────

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function extractHeaders(err: Record<string, unknown>): Record<string, string> | null {
  // The SDK error may expose headers at a few common shapes. Defensive grab.
  const candidates = [
    err.headers,
    (err.response as Record<string, unknown> | undefined)?.headers,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeHeaders(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeHeaders(value: unknown): Record<string, string> | null {
  if (!value) return null;
  // Headers may be a Headers instance (fetch API), a Map, or a plain object.
  if (typeof (value as { forEach?: unknown }).forEach === "function" && typeof (value as { get?: unknown }).get === "function") {
    const out: Record<string, string> = {};
    (value as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (value instanceof Map) {
    const out: Record<string, string> = {};
    for (const [k, v] of value.entries()) {
      if (typeof k === "string") out[k.toLowerCase()] = String(v);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      out[k.toLowerCase()] = String(v);
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

function parseBuckets(headers: Record<string, string>): AnthropicRateLimitBucket[] {
  const kinds: AnthropicRateLimitBucket["kind"][] = [
    "requests",
    "tokens",
    "input-tokens",
    "output-tokens",
  ];
  const buckets: AnthropicRateLimitBucket[] = [];
  for (const kind of kinds) {
    const limit = readNumber(headers[`anthropic-ratelimit-${kind}-limit`]);
    const remaining = readNumber(headers[`anthropic-ratelimit-${kind}-remaining`]);
    const reset = headers[`anthropic-ratelimit-${kind}-reset`];
    if (limit === undefined && remaining === undefined && !reset) continue;
    const bucket: AnthropicRateLimitBucket = { kind };
    if (limit !== undefined) bucket.limit = limit;
    if (remaining !== undefined) bucket.remaining = remaining;
    if (reset) bucket.resetAt = reset;
    buckets.push(bucket);
  }
  return buckets;
}

function parseRetryAfter(value: string | undefined): { seconds?: number; date?: string } | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return { seconds: asNumber };
  }
  // Try HTTP date format.
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return { date: new Date(ms).toISOString() };
}
