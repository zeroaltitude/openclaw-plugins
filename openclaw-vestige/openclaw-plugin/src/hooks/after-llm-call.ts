/**
 * after_llm_call hook handler — Memory Ingestion
 *
 * Scores outbound exchanges (user message + assistant response) for
 * novelty/importance. If above threshold, auto-ingests to Vestige
 * via the smart_ingest endpoint (which handles dedup).
 *
 * Architecture:
 *   1. Extract assistant response text
 *   2. Get the user message from the sliding window
 *   3. Score the exchange via cheap LLM (Haiku)
 *   4. If above threshold → extract key fact → vestige_smart_ingest
 *
 * Latency: This hook runs sequentially but ingestion is fire-and-forget.
 * The LLM scoring adds ~200-400ms but doesn't block response delivery
 * since after_llm_call fires after the response is already captured.
 */

import type { ScorerConfig } from "./llm-scorer.js";
import { scoreOutbound } from "./llm-scorer.js";
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
  scorer: ScorerConfig;
  vestigeServerUrl: string;
  vestigeAuthToken?: string;
  /** Only run on first iteration (default: true) — skip intermediate tool-call responses */
  firstIterationOnly?: boolean;
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
        tags: ["auto-ingested", "hook-saliency", ...tags],
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
  return async (
    event: AfterLlmCallEvent,
    ctx: AgentContext,
  ): Promise<AfterLlmCallResult | void> => {
    // Only run on first iteration by default
    if ((config.firstIterationOnly ?? true) && event.iteration > 0) return;

    // Skip if the response has tool calls — this is a mid-loop iteration,
    // not a final response. We'll catch the final one.
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

    // Score the exchange
    const score = await scoreOutbound(config.scorer, userMessage, responseText);

    if (!score.store || score.score < (config.scorer.storeThreshold ?? 0.5)) {
      return; // Not worth storing
    }

    // Ingest the scorer's summary (not raw conversation — keep vestige clean)
    const summary = score.summary || `${userMessage.slice(0, 100)} → ${responseText.slice(0, 200)}`;
    const tags = score.keywords.length > 0 ? score.keywords : [];

    // Fire and forget — don't block on ingest
    smartIngest(config.vestigeServerUrl, config.vestigeAuthToken, agentId, summary, tags).catch(
      () => {}, // swallow errors silently
    );

    // Don't modify tool calls or block — memory ingestion is purely observational
    return;
  };
}
