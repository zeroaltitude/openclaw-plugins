/**
 * before_prompt_build hook handler — Memory Retrieval (Vestige)
 *
 * REDESIGN (openclaw-vestige-5fq, 2026-05-08):
 * Replaces the per-turn DeBERTa NLI zero-shot pass with layered referent
 * extraction. The NLI scorer was (a) a CPU spike on the gateway main
 * thread on every user turn and (b) the wrong abstraction: topic
 * classification told us *what kind of thing* the user was discussing,
 * but the search query was then polluted with the topic label (e.g.
 * "PR"), dragging dense retrieval toward the centroid of every PR
 * memory. We want memories about the *specific referent*, not the
 * category.
 *
 * New stack (see ./referent/):
 *   1. Cheap salience gate (length + trivial-pattern check) — replaces
 *      the NLI gate. Sub-millisecond, zero CPU.
 *   2. Regex layer        — structured ids (URLs, beads ids, paths, SHAs)
 *   3. Gazetteer layer    — auto-derived proper nouns (repos, plugins,
 *                           agents) from on-disk sources, refreshed via
 *                           fs.watch.
 *   4. KeyBERT layer      — novel n-grams via sentence-embedding cosine
 *                           similarity. Lazy-loaded (~25MB MiniLM model).
 *
 * Architecture (unchanged):
 *   1. Detect active-memory sub-agent (skip — never recurse)
 *   2. Extract latest user message
 *   3. Cheap salience gate
 *   4. Layered referent extraction (regex + gazetteer + keybert in parallel)
 *   5. Build search query: userMessage.slice(0,200) + space-joined unique referents
 *   6. Vestige hybrid search → prepend memories via prependContext
 *
 * Latency budget: blocks time-to-first-token. Target: <500ms steady
 * state. First-call cost includes ~25MB embedding model download.
 */

import { addToWindow } from "./sliding-window.js";
import {
  extractReferents,
  buildSearchQuery,
  pickMemoryTag,
  shouldSearchMemory,
  ensureGazetteerForWorkspace,
  type ExtractedReferent,
} from "./referent/index.js";

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
  /**
   * Concept labels are no longer used (NLI scorer removed from this hook).
   * Field retained on the config interface for backward compatibility but
   * intentionally ignored. Will be removed in a future major.
   */
  conceptLabels?: string[];
  /** Backward-compat alias — also ignored. */
  saliencyThreshold?: number;
  /** Max memories to inject (default: 5) */
  maxMemories?: number;
  /** Max tokens to spend on injected memories (default: 1000) */
  maxMemoryTokens?: number;
  /**
   * Per-memory character cap before token counting (default: 600).
   * Vestige merges [Updated YYYY-MM-DD] history into single records, so some
   * bodies grow to 100KB+. We excerpt the head and let the model pull the
   * full record via vestige_search if it wants more.
   */
  maxPerMemoryChars?: number;
  /** Disable KeyBERT layer (e.g. low-mem environments). Default: enabled. */
  disableKeybert?: boolean;
  /** Maximum referents to send to the search query (default: 8) */
  maxReferents?: number;
  /** Logger for debug output */
  logger?: Logger;
}

// ── Constants ──────────────────────────────────────────────────────────

const MEMORY_BLOCK_START = "<!-- vestige:recalled-memories -->";
const MEMORY_BLOCK_END = "<!-- /vestige:recalled-memories -->";

// ── Helpers ─────────────────────────────────────────────────────────────

function extractSystemPromptFromMessages(messages: AgentMessage[]): string {
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
  const log = config.logger ?? noopLogger;
  const enableKeybert = !config.disableKeybert;
  const maxReferents = config.maxReferents ?? 8;

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
    const systemPromptText = extractSystemPromptFromMessages(event.messages);
    if (systemPromptText.includes("You are a memory search agent.")) {
      log.info(`[vestige] skipping — inside active-memory sub-agent`);
      return;
    }

    log.info(
      `[vestige] userMessage (${userMessage.length} chars): "${userMessage.slice(0, 80)}..."`,
    );

    // Track for outbound saliency scoring (llm_output uses NLI on the
    // user→assistant exchange; that's a separate hook, untouched).
    addToWindow(sessionKey, { role: "user", content: userMessage, agentId });

    // ── Cheap salience gate ───────────────────────────────────────────
    if (!shouldSearchMemory(userMessage)) {
      log.info(`[vestige] skipping — cheap salience gate (trivial/short message)`);
      return;
    }

    // ── Referent extraction (regex + gazetteer + keybert in parallel) ──
    const gazetteer = ensureGazetteerForWorkspace(ctx.workspaceDir);
    let refs: ExtractedReferent[] = [];
    try {
      const extT0 = Date.now();
      refs = await extractReferents(userMessage, {
        gazetteer,
        enableKeybert,
        maxReferents,
      });
      log.info(
        `[vestige] referents extracted in ${Date.now() - extT0}ms (${refs.length}): ${refs
          .map((r) => `${r.source}:${r.value}`)
          .slice(0, 6)
          .join(", ")}`,
      );
    } catch (err) {
      log.warn(`[vestige] referent extractor failed (continuing without):`, err);
    }

    // TODO(openclaw-vestige-5fq): optional NER fallback if KeyBERT recall
    // disappoints in production. Layered escalation: only run NER if the
    // combined regex+gazetteer+keybert haul came back empty *and* the
    // message is long enough to plausibly contain a named entity.

    const query = buildSearchQuery(userMessage, refs);
    log.info(`[vestige] search query: "${query.slice(0, 120)}${query.length > 120 ? "…" : ""}"`);

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

    // Build memory injection, respecting token budget.
    //
    // Each memory is truncated to maxPerMemoryChars before token counting.
    // Memories grow over time as Vestige merges [Updated YYYY-MM-DD] history
    // into the same record — some bodies are 100KB+ — so we excerpt the head
    // and let the model pull the full record via vestige_search if it wants.
    //
    // We also `continue` (not `break`) on overflow so a single huge memory
    // doesn't shut out smaller ones behind it.
    const maxTokens = config.maxMemoryTokens ?? 1000;
    const maxPerMemoryChars = config.maxPerMemoryChars ?? 600;
    const memoryLines: string[] = [];
    let tokenCount = 0;
    let skipped = 0;

    const tag = pickMemoryTag(refs);

    for (const result of results) {
      const raw = (result as { content?: unknown }).content;
      if (typeof raw !== "string") {
        skipped++;
        continue;
      }
      const truncated =
        raw.length > maxPerMemoryChars
          ? raw.slice(0, maxPerMemoryChars).trimEnd() + "…"
          : raw;
      const tokens = estimateTokens(truncated);
      if (tokenCount + tokens > maxTokens) {
        skipped++;
        continue;
      }
      memoryLines.push(`• [${tag}] ${truncated}`);
      tokenCount += tokens;
    }

    if (memoryLines.length === 0) {
      log.warn(
        `[vestige] all ${results.length} results dropped during budget pass (maxTokens=${maxTokens}, maxPerMemoryChars=${maxPerMemoryChars}, skipped=${skipped}) — no injection`,
      );
      return;
    }

    const memoryBlock = [MEMORY_BLOCK_START, ...memoryLines, MEMORY_BLOCK_END].join("\n");

    log.info(
      `[vestige] ⏱ before_prompt_build total: ${Date.now() - t0}ms — injected ${memoryLines.length} memories (${tokenCount} est tokens) via prependContext`,
    );
    return { prependContext: memoryBlock };
  };
}
