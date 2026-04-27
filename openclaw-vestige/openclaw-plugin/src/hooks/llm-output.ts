/**
 * llm_output hook handler — Memory Ingestion (Vestige)
 *
 * Migrated from after_llm_call. Mainline removed after_llm_call as part
 * of Vincent's split hook model; the supported observation hook for
 * post-call model output is now `llm_output`. Differences from the old:
 *
 *   - Event payload no longer carries `toolCalls` directly. The skip-on-
 *     mid-loop-iteration heuristic now checks `assistantTexts.length === 0`
 *     instead — when the model returned only tool-use blocks (no text), the
 *     normalised assistant text array is empty. That matches the old
 *     "skip when there are tool calls" intent: we ingest only on turns that
 *     emitted user-visible response text.
 *
 *   - Event payload uses `assistantTexts: string[]` and `lastAssistant`
 *     instead of `event.response`. We concatenate `assistantTexts` to get
 *     the response text. (This is sometimes empty even when `lastAssistant`
 *     has content — vestige tolerates either source.)
 *
 *   - Iteration counter is no longer on the event. We simply ingest on
 *     every llm_output that has text — vestige uses smart_ingest which
 *     dedups, so re-firing across loop iterations is idempotent.
 *
 * Behaviour (unchanged):
 *   1. Concatenate response text from `assistantTexts`
 *   2. Score the user→assistant exchange via local NLI classifier
 *   3. If salient → vestige_smart_ingest (fire-and-forget)
 *
 * Latency: this hook is observation-only and runs after the response is
 * captured; ingestion is fire-and-forget. No impact on response delivery.
 */

import {
  scoreConcepts,
  hasSalientConcepts,
  getSalientLabels,
  DEFAULT_CONCEPT_LABELS,
} from "./nli-scorer.js";
import { addToWindow, getLastUserMessage } from "./sliding-window.js";

// ── Types (matching mainline OpenClaw plugin hook signatures) ──────────

interface LlmOutputEvent {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  resolvedRef?: string;
  harnessId?: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  // Identity fields intentionally omitted — see before-prompt-build.ts.
}

// ── Config ─────────────────────────────────────────────────────────────

interface LlmOutputConfig {
  vestigeServerUrl: string;
  vestigeAuthToken?: string;
  /** Concept labels for NLI scoring (defaults provided) */
  conceptLabels?: string[];
  /** Minimum NLI score to consider a concept salient for storage (default: 0.3) */
  saliencyThreshold?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function extractResponseText(event: LlmOutputEvent): string | null {
  const concatenated = (event.assistantTexts ?? []).join("\n").trim();
  if (concatenated.length > 0) return concatenated;

  // Fallback: try to dig text out of lastAssistant if assistantTexts empty.
  const last = event.lastAssistant as
    | { content?: string | Array<{ type?: string; text?: string }> }
    | undefined;
  if (!last) return null;
  const content = last.content;
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const text = content
      .filter((p) => p?.type === "text" && typeof p.text === "string" && p.text)
      .map((p) => p.text!)
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
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
        context: `Auto-ingested by llm_output hook for agent ${agentId}`,
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

export function createLlmOutputHandler(config: LlmOutputConfig) {
  const conceptLabels = config.conceptLabels
    ? [...new Set([...DEFAULT_CONCEPT_LABELS, ...config.conceptLabels])]
    : DEFAULT_CONCEPT_LABELS;
  const threshold = config.saliencyThreshold ?? 0.3;

  return async (event: LlmOutputEvent, ctx: AgentContext): Promise<void> => {
    // Skip if the model emitted no user-visible text — this is a tool-only
    // mid-loop iteration. We only ingest when there's a real response.
    const responseText = extractResponseText(event);
    if (!responseText || responseText.length < 20) return;

    const sessionKey = ctx.sessionKey ?? "__unknown__";
    const agentId = ctx.agentId ?? "unknown";

    // Add assistant response to the sliding window
    addToWindow(sessionKey, { role: "assistant", content: responseText, agentId });

    const userMessage = getLastUserMessage(sessionKey);
    if (!userMessage) return;

    const exchange = `User: ${userMessage}\nAssistant: ${responseText.slice(0, 300)}`;

    let scores;
    try {
      scores = await scoreConcepts(exchange, conceptLabels);
    } catch {
      return;
    }

    if (!hasSalientConcepts(scores, threshold)) return;

    const salientLabels = getSalientLabels(scores, threshold);
    const summary = `${userMessage.slice(0, 100)} → ${responseText.slice(0, 200)}`;

    smartIngest(
      config.vestigeServerUrl,
      config.vestigeAuthToken,
      agentId,
      summary,
      salientLabels,
    ).catch(() => {}); // swallow errors silently
  };
}
