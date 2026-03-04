/**
 * before_llm_call hook handler — Memory Retrieval
 *
 * Scores inbound user messages for saliency. If above threshold,
 * searches Vestige for relevant memories and injects them into
 * the message array before the LLM sees them.
 *
 * Architecture:
 *   1. Extract latest user message
 *   2. Score saliency via cheap LLM (Haiku)
 *   3. If above threshold → search Vestige → cross-reference results
 *   4. Inject top-k memories as a synthetic system message
 *      positioned just before the latest user message
 *   5. Return modified messages array
 *
 * Latency budget: This hook blocks time-to-first-token.
 * Target: <500ms total (LLM scoring ~200ms + Vestige search ~100ms).
 */

import type { ScorerConfig } from "./llm-scorer.js";
import { scoreInbound } from "./llm-scorer.js";
import { addToWindow, getRecentContext } from "./sliding-window.js";
import { scoreGate, ensureInitialized, type GateConfig } from "./saliency-gate.js";

// ── Types (matching OpenClaw plugin hook signatures) ───────────────────

interface AgentMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

interface BeforeLlmCallEvent {
  messages: AgentMessage[];
  systemPrompt: string;
  model: string;
  iteration: number;
  tools: Array<{ name: string; description?: string }>;
  tokenEstimate?: number;
}

interface BeforeLlmCallResult {
  messages?: AgentMessage[];
  systemPrompt?: string;
  tools?: Array<{ name: string }>;
  block?: boolean;
  blockReason?: string;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  senderId?: string | null;
  senderName?: string | null;
  senderIsOwner?: boolean;
  groupId?: string | null;
  spawnedBy?: string | null;
}

// ── Config ─────────────────────────────────────────────────────────────

interface BeforeLlmCallConfig {
  scorer: ScorerConfig;
  vestigeServerUrl: string;
  vestigeAuthToken?: string;
  /** Max memories to inject (default: 5) */
  maxMemories?: number;
  /** Max tokens to spend on injected memories (default: 1000) */
  maxMemoryTokens?: number;
  /** Only run on first iteration (default: true) — skip tool-call loops */
  firstIterationOnly?: boolean;
  /** Bi-encoder gate config (thresholds for dual-centroid scoring) */
  gate?: GateConfig;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function extractUserMessage(messages: AgentMessage[]): string | null {
  // Walk backwards to find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const textParts = content.filter((p) => p.type === "text" && p.text);
        return textParts.map((p) => p.text!).join("\n");
      }
    }
  }
  return null;
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function searchVestige(
  serverUrl: string,
  authToken: string | undefined,
  query: string,
  agentId: string,
  limit: number,
): Promise<Array<{ content: string; score: number; id: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const resp = await fetch(`${serverUrl.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        "X-Agent-Id": agentId,
      },
      body: JSON.stringify({ query, mode: "hybrid", limit, threshold: 0.3 }),
      signal: controller.signal,
    });

    if (!resp.ok) return [];

    const json = await resp.json();
    if (json.success && json.data?.content) {
      // Parse the MCP-style response
      const texts = json.data.content
        .filter((c: any) => c.type === "text" && c.text)
        .map((c: any) => c.text);
      if (texts.length > 0) {
        try {
          const parsed = JSON.parse(texts[0]);
          if (parsed.results) return parsed.results;
        } catch {
          // Not JSON, return raw
        }
      }
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ── Handler ────────────────────────────────────────────────────────────

export function createBeforeLlmCallHandler(config: BeforeLlmCallConfig) {
  return async (
    event: BeforeLlmCallEvent,
    ctx: AgentContext,
  ): Promise<BeforeLlmCallResult | void> => {
    // Only run on first iteration by default (skip tool-call loop iterations)
    if ((config.firstIterationOnly ?? true) && event.iteration > 0) return;

    const userMessage = extractUserMessage(event.messages);
    if (!userMessage || userMessage.length < 5) return;

    const sessionKey = ctx.sessionKey ?? "__unknown__";
    const agentId = ctx.agentId ?? "unknown";

    // Add to sliding window
    addToWindow(sessionKey, { role: "user", content: userMessage, agentId });

    // Stage 1: Bi-encoder gate (~5-10ms) — skip obvious noise before paying LLM cost
    try {
      const gateResult = await scoreGate(userMessage, config.gate);
      if (!gateResult.passToScorer) {
        return; // Low-value message — skip entirely
      }
      // If high-value, we still run the LLM scorer to get keywords for search
    } catch {
      // Gate failed (model not loaded, etc.) — fall through to LLM scorer
      // This is the graceful degradation path
    }

    // Stage 2: LLM scorer (~200-400ms) — nuanced saliency + keyword extraction
    const recentContext = getRecentContext(sessionKey);
    const score = await scoreInbound(config.scorer, userMessage, recentContext);

    if (!score.retrieve || score.score < (config.scorer.retrieveThreshold ?? 0.3)) {
      return; // Not worth searching memory
    }

    // Search Vestige using the scorer's keywords
    const query = score.keywords.length > 0 ? score.keywords.join(" ") : userMessage.slice(0, 200);
    const maxMemories = config.maxMemories ?? 5;
    const results = await searchVestige(
      config.vestigeServerUrl,
      config.vestigeAuthToken,
      query,
      agentId,
      maxMemories,
    );

    if (results.length === 0) return;

    // Build memory injection, respecting token budget
    const maxTokens = config.maxMemoryTokens ?? 1000;
    const memories: string[] = [];
    let tokenCount = 0;

    for (const result of results) {
      const tokens = estimateTokens(result.content);
      if (tokenCount + tokens > maxTokens) break;
      memories.push(`• ${result.content}`);
      tokenCount += tokens;
    }

    if (memories.length === 0) return;

    // Inject as a synthetic system message just before the last user message
    const memoryMessage: AgentMessage = {
      role: "system",
      content: `## Recalled Memories (auto-retrieved)\n${memories.join("\n")}`,
    };

    // Find insertion point: just before the last user message
    const messages = [...event.messages];
    let insertIdx = messages.length - 1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        insertIdx = i;
        break;
      }
    }

    messages.splice(insertIdx, 0, memoryMessage);

    return { messages };
  };
}
