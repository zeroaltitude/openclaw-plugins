/**
 * before_prompt_build hook handler — Memory Retrieval (Vestige)
 *
 * Migrated from before_llm_call. Mainline removed before_llm_call as part
 * of Vincent's split hook model; the supported mutating prompt-policy hook
 * is now `before_prompt_build`. Concrete differences from the old hook:
 *
 *   - Event payload is `{ prompt, messages }` only (no `systemPrompt`,
 *     `tools`, or `iteration` fields). System prompt is read from
 *     messages[0] when needed for sub-agent detection. Iteration filter
 *     is dropped — `before_prompt_build` fires once per turn (not per
 *     model-call iteration), so the original first-iteration-only guard
 *     is implicit.
 *
 *   - Result is `{ prependContext?, prependSystemContext?, appendSystemContext?, systemPrompt? }`.
 *     We use `prependContext` to inject recalled memories — it is prefixed
 *     to the user prompt for the model, and is per-turn (no accumulation
 *     in conversation history). This eliminates the strip-old-memory-
 *     blocks pass that was needed when the old handler injected a
 *     synthetic system message into `messages`.
 *
 *   - `.forget` command UX is reduced: we can no longer rewrite the user
 *     message in-place. We still demote matching memories and surface a
 *     short acknowledgement via prependContext so the LLM has the
 *     context, but the literal `.forget X` text remains visible. Moving
 *     that command to an `inbound_claim` hook is a future cleanup.
 *
 * Architecture (unchanged):
 *   1. Detect active-memory sub-agent (skip — never recurse)
 *   2. Extract latest user message
 *   3. Score concepts via local NLI zero-shot classifier
 *   4. If salient → search Vestige → return prependContext with memories
 *
 * Latency budget: blocks time-to-first-token. Target: <500ms.
 */

import {
  scoreConcepts,
  hasSalientConcepts,
  getSalientLabels,
  DEFAULT_CONCEPT_LABELS,
  type ConceptScore,
} from "./nli-scorer.js";
import { addToWindow } from "./sliding-window.js";

// ── Types (matching mainline OpenClaw plugin hook signatures) ──────────

interface AgentMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

interface BeforePromptBuildEvent {
  prompt: string;
  messages: AgentMessage[];
}

interface BeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  // Identity fields (senderId/senderIsOwner/etc.) intentionally omitted —
  // mainline does not populate them on the agent hookCtx; identity-bearing
  // hooks are inbound_claim / message_received / subagent_spawned. Vestige
  // does not need identity for retrieval.
}

interface Logger {
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

const noopLogger: Logger = { info() {}, warn() {}, error() {} };

interface BeforePromptBuildConfig {
  vestigeServerUrl: string;
  vestigeAuthToken?: string;
  /** Concept labels for NLI scoring (defaults provided) */
  conceptLabels?: string[];
  /** Minimum NLI score to consider a concept salient (default: 0.3) */
  saliencyThreshold?: number;
  /** Max memories to inject (default: 5) */
  maxMemories?: number;
  /** Max tokens to spend on injected memories (default: 1000) */
  maxMemoryTokens?: number;
  /** Logger for debug output */
  logger?: Logger;
}

// ── Constants ──────────────────────────────────────────────────────────

const MEMORY_BLOCK_START = "<!-- vestige:recalled-memories -->";
const MEMORY_BLOCK_END = "<!-- /vestige:recalled-memories -->";

// ── Helpers ─────────────────────────────────────────────────────────────

function extractSystemPromptFromMessages(messages: AgentMessage[]): string {
  // Conventionally the system prompt sits at index 0 with role "system".
  // Some surfaces may put it later, so scan from the front for the first
  // system message.
  for (const msg of messages) {
    if (msg.role !== "system") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
    }
  }
  return "";
}

function extractUserMessage(prompt: string, messages: AgentMessage[]): string | null {
  // Prefer the explicit `prompt` field — that's the current turn's input.
  // Fall back to scanning messages for the latest user role.
  if (prompt && prompt.trim().length > 0) return prompt;
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

async function demoteMemory(
  serverUrl: string,
  authToken: string | undefined,
  memoryId: string,
  agentId: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const resp = await fetch(`${serverUrl.replace(/\/+$/, "")}/demote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        "X-Agent-Id": agentId,
      },
      body: JSON.stringify({ memory_id: memoryId }),
      signal: controller.signal,
    });

    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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

export function createBeforePromptBuildHandler(config: BeforePromptBuildConfig) {
  // Merge user-provided labels with defaults (additive, deduplicated)
  const conceptLabels = config.conceptLabels
    ? [...new Set([...DEFAULT_CONCEPT_LABELS, ...config.conceptLabels])]
    : DEFAULT_CONCEPT_LABELS;
  const threshold = config.saliencyThreshold ?? 0.3;
  const log = config.logger ?? noopLogger;

  return async (
    event: BeforePromptBuildEvent,
    ctx: AgentContext,
  ): Promise<BeforePromptBuildResult | void> => {
    const t0 = Date.now();
    log.info(
      `[vestige] before_prompt_build fired — msgCount=${event.messages.length}, promptLen=${event.prompt?.length ?? 0}`,
    );

    const agentId = ctx.agentId ?? "unknown";
    const sessionKey = ctx.sessionKey ?? "__unknown__";
    const userMessage = extractUserMessage(event.prompt, event.messages);

    if (!userMessage || userMessage.length < 5) {
      log.info(`[vestige] skipping — userMessage too short or missing`);
      return;
    }

    // ── .forget command: demote matching memories, acknowledge via prependContext ──
    // (UX is reduced from the old in-place message rewrite; promotion to
    // an inbound_claim hook is the proper home and is a future cleanup.)
    if (userMessage.trim().toLowerCase().startsWith(".forget ")) {
      const query = userMessage.trim().slice(".forget ".length).trim();
      if (query.length > 0) {
        const results = await searchVestige(
          config.vestigeServerUrl,
          config.vestigeAuthToken,
          query,
          agentId,
          3,
        );
        for (const result of results.slice(0, 3)) {
          await demoteMemory(
            config.vestigeServerUrl,
            config.vestigeAuthToken,
            result.id,
            agentId,
          );
        }
        const acknowledgment =
          results.length > 0
            ? `[vestige] Demoted ${results.length} ${results.length === 1 ? "memory" : "memories"} matching: ${query}`
            : `[vestige] No memories found matching: ${query}`;
        log.info(`[vestige] ${acknowledgment}`);
        return { prependContext: acknowledgment };
      }
    }

    // ── Sub-agent detection: skip when running inside active-memory sub-agent ──
    // The active-memory plugin spawns memory-search sub-agents with a
    // recognisable system prompt prefix. Firing Vestige there would
    // recurse and burn the sub-agent's latency budget.
    const systemPromptText = extractSystemPromptFromMessages(event.messages);
    if (systemPromptText.includes("You are a memory search agent.")) {
      log.info(`[vestige] skipping — inside active-memory sub-agent`);
      return;
    }

    log.info(
      `[vestige] userMessage (${userMessage.length} chars): "${userMessage.slice(0, 80)}..."`,
    );

    // Add to sliding window for outbound saliency scoring later
    addToWindow(sessionKey, { role: "user", content: userMessage, agentId });

    // Score concepts via local NLI classifier
    let scores: ConceptScore[];
    try {
      const nliT0 = Date.now();
      scores = await scoreConcepts(userMessage, conceptLabels);
      log.info(
        `[vestige] NLI scored in ${Date.now() - nliT0}ms — top: ${scores
          .slice(0, 3)
          .map((s) => `${s.label}=${s.score.toFixed(3)}`)
          .join(", ")}`,
      );
    } catch (err) {
      log.error(`[vestige] NLI scorer failed:`, err);
      return;
    }

    if (!hasSalientConcepts(scores, threshold)) {
      log.info(`[vestige] no salient concepts above threshold=${threshold} — skipping retrieval`);
      return;
    }

    const salientLabels = getSalientLabels(scores, threshold);
    log.info(`[vestige] salient labels: ${salientLabels.join(", ")}`);
    const query = `${userMessage.slice(0, 200)} ${salientLabels.join(" ")}`.trim();

    const maxMemories = config.maxMemories ?? 5;
    const searchT0 = Date.now();
    const results = await searchVestige(
      config.vestigeServerUrl,
      config.vestigeAuthToken,
      query,
      agentId,
      maxMemories,
    );
    log.info(`[vestige] search returned ${results.length} results in ${Date.now() - searchT0}ms`);

    if (results.length === 0) {
      log.info(`[vestige] no memories found — skipping injection`);
      return;
    }

    // Build memory injection, respecting token budget
    const maxTokens = config.maxMemoryTokens ?? 1000;
    const memoryLines: string[] = [];
    let tokenCount = 0;

    const topLabel = salientLabels[0] ?? "memory";

    for (const result of results) {
      const tokens = estimateTokens(result.content);
      if (tokenCount + tokens > maxTokens) break;
      memoryLines.push(`• [${topLabel}] ${result.content}`);
      tokenCount += tokens;
    }

    if (memoryLines.length === 0) return;

    const memoryBlock = [MEMORY_BLOCK_START, ...memoryLines, MEMORY_BLOCK_END].join("\n");

    log.info(
      `[vestige] ⏱ before_prompt_build total: ${Date.now() - t0}ms — injected ${memoryLines.length} memories (${tokenCount} est tokens) via prependContext`,
    );
    return { prependContext: memoryBlock };
  };
}
