/**
 * Lightweight LLM scorer for saliency/importance evaluation.
 * Extracted from Cortex reflection system — calls a cheap LLM (Haiku)
 * with structured JSON output for fast, nuanced scoring.
 *
 * Used by both before_llm_call (retrieval gating) and after_llm_call (ingestion gating).
 */

import https from "https";

// ── Types ──────────────────────────────────────────────────────────────

export interface SaliencyScore {
  /** Should we search memory for this message? */
  retrieve: boolean;
  /** Is this exchange worth storing in memory? */
  store: boolean;
  /** Overall importance score 0-1 */
  score: number;
  /** Search terms to use if retrieving */
  keywords: string[];
  /** Distilled fact/decision to store if storing */
  summary: string;
  /** Brief reasoning for the score */
  reason: string;
}

export interface ScorerConfig {
  /** Anthropic API key */
  apiKey: string;
  /** Model to use (default: claude-haiku-4-5-20250620) */
  model?: string;
  /** Timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Minimum score to trigger retrieval (default: 0.3) */
  retrieveThreshold?: number;
  /** Minimum score to trigger storage (default: 0.5) */
  storeThreshold?: number;
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = "claude-haiku-4-5-20250620";
const DEFAULT_TIMEOUT_MS = 5_000;

// ── Prompts ────────────────────────────────────────────────────────────

const INBOUND_SYSTEM_PROMPT = `You are a memory relevance scorer for an AI assistant.
Given the user's message (and optional recent context), determine:
1. Whether relevant memories should be retrieved to help answer this message
2. What search terms would find the most relevant memories

Score 0-1 where:
- 0.0-0.2: Casual/phatic ("hey", "thanks", "lol") — no memory needed
- 0.2-0.4: Simple questions that might benefit from context
- 0.4-0.7: Questions/tasks where prior context would meaningfully help
- 0.7-1.0: Explicit references to past work, preferences, or decisions

Respond with ONLY valid JSON:
{"retrieve":true/false,"store":false,"score":0.0-1.0,"keywords":["term1","term2"],"summary":"","reason":"brief explanation"}`;

const OUTBOUND_SYSTEM_PROMPT = `You are a memory importance scorer for an AI assistant.
Given the exchange (user message + assistant response), determine:
1. Whether this exchange contains information worth remembering long-term
2. What the key fact/decision/preference is, distilled to one sentence

Score 0-1 where:
- 0.0-0.2: Routine exchanges, greetings, acknowledgments
- 0.2-0.4: Mildly interesting but ephemeral information
- 0.4-0.7: Useful context, preferences, or decisions worth recalling
- 0.7-1.0: Critical facts, explicit "remember this", strong preferences, key decisions

Respond with ONLY valid JSON:
{"retrieve":false,"store":true/false,"score":0.0-1.0,"keywords":[],"summary":"one-line distillation of what to remember","reason":"brief explanation"}`;

// ── LLM Call ───────────────────────────────────────────────────────────

function callLlm(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  timeoutMs: number,
): Promise<SaliencyScore> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LLM scorer timed out")), timeoutMs);

    const body = JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: userContent }],
      system: systemPrompt,
    });

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            const text = parsed?.content?.[0]?.text || "";
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const result = JSON.parse(jsonMatch[0]) as SaliencyScore;
              resolve(result);
            } else {
              reject(new Error("No JSON in scorer response: " + text.slice(0, 100)));
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Score an inbound user message for memory retrieval relevance.
 * Returns keywords to search if retrieval is warranted.
 */
export async function scoreInbound(
  config: ScorerConfig,
  userMessage: string,
  recentContext?: string[],
): Promise<SaliencyScore> {
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let content = userMessage;
  if (recentContext && recentContext.length > 0) {
    content = `Recent context:\n${recentContext.slice(-5).join("\n")}\n\nCurrent message:\n${userMessage}`;
  }

  try {
    return await callLlm(config.apiKey, model, INBOUND_SYSTEM_PROMPT, content, timeoutMs);
  } catch {
    // On failure, return a safe default (no retrieval)
    return {
      retrieve: false,
      store: false,
      score: 0,
      keywords: [],
      summary: "",
      reason: "scorer failed — defaulting to skip",
    };
  }
}

/**
 * Score an outbound exchange (user message + assistant response)
 * for memory storage importance.
 */
export async function scoreOutbound(
  config: ScorerConfig,
  userMessage: string,
  assistantResponse: string,
): Promise<SaliencyScore> {
  const model = config.model ?? DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const content = `User: ${userMessage}\n\nAssistant: ${assistantResponse}`;

  try {
    return await callLlm(config.apiKey, model, OUTBOUND_SYSTEM_PROMPT, content, timeoutMs);
  } catch {
    // On failure, return a safe default (no storage)
    return {
      retrieve: false,
      store: false,
      score: 0,
      keywords: [],
      summary: "",
      reason: "scorer failed — defaulting to skip",
    };
  }
}
