import { describe, expect, it } from "vitest";
import {
  formatRateLimitMessage,
  parseAnthropicRateLimitError,
  type AnthropicRateLimitState,
} from "../src/rate-limits.js";

describe("parseAnthropicRateLimitError", () => {
  it("returns null for non-error values", () => {
    expect(parseAnthropicRateLimitError(null)).toBeNull();
    expect(parseAnthropicRateLimitError(undefined)).toBeNull();
    expect(parseAnthropicRateLimitError("oops")).toBeNull();
    expect(parseAnthropicRateLimitError(42)).toBeNull();
  });

  it("returns null when there is neither 429 status nor headers", () => {
    expect(parseAnthropicRateLimitError(new Error("boom"))).toBeNull();
  });

  it("captures 429 with no headers as a minimal state", () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      status: 429,
    });
    const state = parseAnthropicRateLimitError(err);
    expect(state?.status).toBe(429);
    expect(state?.buckets).toEqual([]);
    expect(state?.rawMessage).toBe("Too Many Requests");
  });

  it("parses retry-after as integer seconds", () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": "30" },
    });
    const state = parseAnthropicRateLimitError(err);
    expect(state?.retryAfterSeconds).toBe(30);
    expect(state?.retryAfterDate).toBeUndefined();
  });

  it("parses retry-after as HTTP date", () => {
    const date = new Date("2026-05-22T12:00:00Z").toUTCString();
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": date },
    });
    const state = parseAnthropicRateLimitError(err);
    expect(state?.retryAfterDate).toBe("2026-05-22T12:00:00.000Z");
    expect(state?.retryAfterSeconds).toBeUndefined();
  });

  it("parses bucket headers (requests, tokens, input-tokens, output-tokens)", () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "0",
        "anthropic-ratelimit-requests-reset": "2026-05-22T12:34:56Z",
        "anthropic-ratelimit-tokens-limit": "80000",
        "anthropic-ratelimit-tokens-remaining": "5000",
        "anthropic-ratelimit-input-tokens-limit": "50000",
        "anthropic-ratelimit-input-tokens-remaining": "1000",
        "anthropic-ratelimit-output-tokens-limit": "20000",
        "anthropic-ratelimit-output-tokens-remaining": "20000",
      },
    });
    const state = parseAnthropicRateLimitError(err);
    expect(state).not.toBeNull();
    expect(state!.buckets).toEqual([
      { kind: "requests", limit: 1000, remaining: 0, resetAt: "2026-05-22T12:34:56Z" },
      { kind: "tokens", limit: 80000, remaining: 5000 },
      { kind: "input-tokens", limit: 50000, remaining: 1000 },
      { kind: "output-tokens", limit: 20000, remaining: 20000 },
    ]);
  });

  it("captures rate-limit headers even on a non-429 (informational use)", () => {
    const err = Object.assign(new Error("transport error"), {
      status: 500,
      headers: {
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "750",
      },
    });
    const state = parseAnthropicRateLimitError(err);
    expect(state?.status).toBe(500);
    expect(state?.buckets[0]).toEqual({ kind: "requests", limit: 1000, remaining: 750 });
  });

  it("accepts Headers-style (fetch API) header objects", () => {
    const headers = new Headers({
      "retry-after": "60",
      "anthropic-ratelimit-requests-remaining": "10",
    });
    const err = Object.assign(new Error("limited"), { status: 429, headers });
    const state = parseAnthropicRateLimitError(err);
    expect(state?.retryAfterSeconds).toBe(60);
    expect(state?.buckets[0]?.remaining).toBe(10);
  });

  it("looks for headers under err.response.headers (nested SDK shape)", () => {
    const err = Object.assign(new Error("limited"), {
      status: 429,
      response: { headers: { "retry-after": "5" } },
    });
    const state = parseAnthropicRateLimitError(err);
    expect(state?.retryAfterSeconds).toBe(5);
  });
});

describe("formatRateLimitMessage", () => {
  it("emits a 429 lead-in when status === 429", () => {
    const state: AnthropicRateLimitState = {
      status: 429,
      buckets: [],
      retryAfterSeconds: 12,
    };
    const out = formatRateLimitMessage(state);
    expect(out).toContain("Anthropic rate limit hit (HTTP 429)");
    expect(out).toContain("Retry after ~12s");
  });

  it("renders multiple buckets in a readable form", () => {
    const state: AnthropicRateLimitState = {
      status: 429,
      buckets: [
        { kind: "requests", limit: 100, remaining: 0, resetAt: "2026-05-22T12:00:00Z" },
        { kind: "tokens", limit: 80000, remaining: 4321 },
      ],
    };
    const out = formatRateLimitMessage(state);
    expect(out).toContain("requests: 0/100 (resets 2026-05-22T12:00:00Z)");
    expect(out).toContain("tokens: 4321/80000");
  });

  it("appends underlying error message when present", () => {
    const state: AnthropicRateLimitState = {
      status: 429,
      buckets: [],
      rawMessage: "Tokens per minute exceeded",
    };
    const out = formatRateLimitMessage(state);
    expect(out).toContain("Underlying error: Tokens per minute exceeded");
  });
});
