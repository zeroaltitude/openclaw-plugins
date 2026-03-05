/**
 * before_llm_call hook handler — Memory Retrieval
 *
 * Scores inbound user messages for saliency using local DeBERTa NLI classifier.
 * If salient concepts detected, searches Vestige for relevant memories and
 * injects them into the message array before the LLM sees them.
 *
 * Architecture:
 *   1. Strip any previously injected vestige memory blocks (context hygiene)
 *   2. Extract latest user message
 *   3. Score concepts via local NLI zero-shot classifier (~50-200ms)
 *   4. If salient → search Vestige → inject memories
 *   5. Return modified messages array
 *
 * Latency budget: This hook blocks time-to-first-token.
 * Target: <500ms total (NLI scoring ~100ms + Vestige search ~100ms).
 */

import {
  scoreConcepts,
  hasSalientConcepts,
  getSalientLabels,
  DEFAULT_CONCEPT_LABELS,
  type ConceptScore,
} from "./nli-scorer.js";
import { addToWindow } from "./sliding-window.js";

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
  vestigeServerUrl: string;
  vestigeAuthToken?: string;
  /** Concept labels for NLI scoring (defaults provided) */
  conceptLabels?: string[];
  /** Minimum NLI score to consider a concept salient (default: 0.5) */
  saliencyThreshold?: number;
  /** Max memories to inject (default: 5) */
  maxMemories?: number;
  /** Max tokens to spend on injected memories (default: 1000) */
  maxMemoryTokens?: number;
  /** Only run on first iteration (default: true) — skip tool-call loops */
  firstIterationOnly?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const MEMORY_BLOCK_START = "<!-- vestige:recalled-memories -->";
const MEMORY_BLOCK_END = "<!-- /vestige:recalled-memories -->";
const MEMORY_BLOCK_REGEX = /<!-- vestige:recalled-memories -->[\s\S]*?<!-- \/vestige:recalled-memories -->/g;

// ── Helpers ─────────────────────────────────────────────────────────────

function extractUserMessage(messages: AgentMessage[]): string | null {
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

/**
 * Strip previously injected vestige memory blocks from all messages.
 * This ensures we don't accumulate stale memories across turns.
 */
function stripMemoryBlocks(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string" && msg.content.includes(MEMORY_BLOCK_START)) {
      const stripped = msg.content.replace(MEMORY_BLOCK_REGEX, "").trim();
      // If the message is now empty after stripping, keep an empty string
      return { ...msg, content: stripped };
    }
    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map((part) => {
        if (part.type === "text" && part.text && part.text.includes(MEMORY_BLOCK_START)) {
          return { ...part, text: part.text.replace(MEMORY_BLOCK_REGEX, "").trim() };
        }
        return part;
      });
      return { ...msg, content: newContent };
    }
    return msg;
  }).filter((msg) => {
    // Remove messages that are now completely empty after stripping
    if (typeof msg.content === "string") return msg.content.length > 0;
    if (Array.isArray(msg.content)) {
      return msg.content.some((p) => p.type !== "text" || (p.text && p.text.length > 0));
    }
    return true;
  });
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
  const conceptLabels = config.conceptLabels ?? DEFAULT_CONCEPT_LABELS;
  const threshold = config.saliencyThreshold ?? 0.5;

  return async (
    event: BeforeLlmCallEvent,
    ctx: AgentContext,
  ): Promise<BeforeLlmCallResult | void> => {
    // Always strip old memory blocks first (context hygiene)
    const messages = stripMemoryBlocks([...event.messages]);

    // Only run on first iteration by default (skip tool-call loop iterations)
    if ((config.firstIterationOnly ?? true) && event.iteration > 0) {
      // Still return stripped messages even if we skip scoring
      return { messages };
    }

    const userMessage = extractUserMessage(messages);
    if (!userMessage || userMessage.length < 5) {
      return { messages };
    }

    const sessionKey = ctx.sessionKey ?? "__unknown__";
    const agentId = ctx.agentId ?? "unknown";

    // Add to sliding window
    addToWindow(sessionKey, { role: "user", content: userMessage, agentId });

    // Score concepts via local NLI classifier
    let scores: ConceptScore[];
    try {
      scores = await scoreConcepts(userMessage, conceptLabels);
    } catch {
      // NLI scorer failed — return stripped messages, skip retrieval
      return { messages };
    }

    // Check if any salient concepts detected
    if (!hasSalientConcepts(scores, threshold)) {
      return { messages };
    }

    // Build search query: user message + salient concept labels for context
    const salientLabels = getSalientLabels(scores, threshold);
    const query = `${userMessage.slice(0, 200)} ${salientLabels.join(" ")}`.trim();

    const maxMemories = config.maxMemories ?? 5;
    const results = await searchVestige(
      config.vestigeServerUrl,
      config.vestigeAuthToken,
      query,
      agentId,
      maxMemories,
    );

    if (results.length === 0) {
      return { messages };
    }

    // Build memory injection, respecting token budget
    const maxTokens = config.maxMemoryTokens ?? 1000;
    const memoryLines: string[] = [];
    let tokenCount = 0;

    // Use the top salient label for each memory line
    const topLabel = salientLabels[0] ?? "memory";

    for (const result of results) {
      const tokens = estimateTokens(result.content);
      if (tokenCount + tokens > maxTokens) break;
      memoryLines.push(`• [${topLabel}] ${result.content}`);
      tokenCount += tokens;
    }

    if (memoryLines.length === 0) {
      return { messages };
    }

    // Build structured memory block
    const memoryBlock = [
      MEMORY_BLOCK_START,
      ...memoryLines,
      MEMORY_BLOCK_END,
    ].join("\n");

    // Inject as a synthetic system message just before the last user message
    const memoryMessage: AgentMessage = {
      role: "system",
      content: memoryBlock,
    };

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
