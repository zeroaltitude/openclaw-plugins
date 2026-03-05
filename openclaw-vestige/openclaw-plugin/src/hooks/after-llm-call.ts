/**
 * after_llm_call hook handler — Memory Ingestion
 *
 * Scores outbound exchanges (user message + assistant response) for
 * saliency using local DeBERTa NLI classifier. If salient concepts
 * detected, auto-ingests to Vestige via smart_ingest (which handles dedup).
 *
 * Architecture:
 *   1. Extract assistant response text
 *   2. Get the user message from the sliding window
 *   3. Score the exchange via local NLI classifier (~50-200ms)
 *   4. If salient → vestige_smart_ingest (fire-and-forget)
 *
 * Latency: This hook runs after the response is captured, so NLI scoring
 * doesn't block response delivery. Ingestion is fire-and-forget.
 */

import {
  scoreConcepts,
  hasSalientConcepts,
  getSalientLabels,
  DEFAULT_CONCEPT_LABELS,
} from "./nli-scorer.js";
import { addToWindow, getLastUserMessage } from "./sliding-window.js";

// ── Types ──────────────────────────────────────────────────────────────

interface AgentMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

interface AfterLlmCallEvent {
  response: AgentMessage;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  iteration: number;
  model: string;
  latencyMs?: number;
  tokenUsage?: { input: number; output: number };
}

interface AfterLlmCallResult {
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
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

interface AfterLlmCallConfig {
  vestigeServerUrl: string;
  vestigeAuthToken?: string;
  /** Concept labels for NLI scoring (defaults provided) */
  conceptLabels?: string[];
  /** Minimum NLI score to consider a concept salient for storage (default: 0.5) */
  saliencyThreshold?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function extractResponseText(response: AgentMessage): string | null {
  const content = response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content.filter((p) => p.type === "text" && p.text);
    return textParts.map((p) => p.text!).join("\n");
  }
  return null;
}

async function smartIngest(
  serverUrl: string,
  authToken: string | undefined,
  agentId: string,
  content: string,
  tags: string[],
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(`${serverUrl.replace(/\/+$/, "")}/smart_ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        "X-Agent-Id": agentId,
      },
      body: JSON.stringify({
        content,
        node_type: "fact",
        tags: ["auto-ingested", "hook-nli", ...tags],
        context: `Auto-ingested by after_llm_call hook for agent ${agentId}`,
      }),
      signal: controller.signal,
    });
  } catch {
    // Fire-and-forget — don't fail the hook on ingest errors
  } finally {
    clearTimeout(timeout);
  }
}

// ── Handler ────────────────────────────────────────────────────────────

export function createAfterLlmCallHandler(config: AfterLlmCallConfig) {
  // Merge user-provided labels with defaults (additive, deduplicated)
  const conceptLabels = config.conceptLabels
    ? [...new Set([...DEFAULT_CONCEPT_LABELS, ...config.conceptLabels])]
    : DEFAULT_CONCEPT_LABELS;
  const threshold = config.saliencyThreshold ?? 0.3;

  return async (
    event: AfterLlmCallEvent,
    ctx: AgentContext,
  ): Promise<AfterLlmCallResult | void> => {
    // Skip if the response has tool calls — this is a mid-loop iteration,
    // not a final response.
    if (event.toolCalls && event.toolCalls.length > 0) return;

    const responseText = extractResponseText(event.response);
    if (!responseText || responseText.length < 20) return;

    const sessionKey = ctx.sessionKey ?? "__unknown__";
    const agentId = ctx.agentId ?? "unknown";

    // Add assistant response to sliding window
    addToWindow(sessionKey, { role: "assistant", content: responseText, agentId });

    // Get the user message this is responding to
    const userMessage = getLastUserMessage(sessionKey);
    if (!userMessage) return;

    // Score the combined exchange via local NLI classifier
    const exchange = `User: ${userMessage}\nAssistant: ${responseText.slice(0, 300)}`;

    let scores;
    try {
      scores = await scoreConcepts(exchange, conceptLabels);
    } catch {
      // NLI scorer failed — skip ingestion
      return;
    }

    if (!hasSalientConcepts(scores, threshold)) {
      return; // Not worth storing
    }

    // Get salient labels for tags
    const salientLabels = getSalientLabels(scores, threshold);

    // Build a summary: user question + truncated response
    const summary = `${userMessage.slice(0, 100)} → ${responseText.slice(0, 200)}`;

    // Fire and forget — don't block on ingest
    smartIngest(
      config.vestigeServerUrl,
      config.vestigeAuthToken,
      agentId,
      summary,
      salientLabels,
    ).catch(() => {}); // swallow errors silently

    // Don't modify tool calls or block — memory ingestion is purely observational
    return;
  };
}
