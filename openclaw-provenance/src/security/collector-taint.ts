/**
 * Collector-wait taint (openclaw-provenance-0ii).
 *
 * `agents_wait` is not a source of its own. It hands the parent whatever its
 * collector children wrote as their final answer, so the only honest label for
 * its result is the MAXIMUM taint of the children it actually collected — not
 * a constant. A constant "untrusted" locks out a parent whose children all did
 * local work (the 2026-11-12 11:10 Theseus planner lockout); a constant
 * "trusted" would launder a child that read the web.
 *
 * The result carries exactly what is needed. `agents_wait` returns
 * `jsonResult({ completed, pending, errors })` (openclaw
 * src/agents/tools/agents-wait-tool.ts), where every entry of `completed`
 * declares the child's own `sessionKey` (CollectorCompletionSchema). A child
 * session is a first-class provenance session here: it runs its own turn, its
 * own graph, and seals its own watermark.
 *
 * Resolution per child session key, most authoritative first:
 *   1. a live graph for that session (the child is still running in-process);
 *   2. its persisted watermark;
 *   3. "trusted".
 *
 * Step 3 is a fact, not a guess: WatermarkStore.escalate() only creates an
 * entry when the level is worse than trusted ("Only create watermark if taint
 * is worse than trusted", watermark-store.ts), so a child that finished with
 * no watermark finished trusted. Two residual holes, both logged by the caller
 * and recorded in the 0ii report:
 *   - a child whose own session key is system-source (`:cron:`, `:heartbeat:`)
 *     never persists a watermark at all, so after its graph is sealed it reads
 *     as trusted;
 *   - watermark entries are pruned by age, so a long-dead child reads as
 *     trusted.
 * Neither applies to the ordinary case this fixes: a parent waiting, inside
 * one turn, on children it just spawned.
 */

import { minTrust, stripKnownMcpPrefix, type TrustLevel } from "./trust-levels.js";

/** The collector-wait tool, under every name a harness reports it by. */
const COLLECTOR_WAIT_TOOL_NAME = "agents_wait";

/**
 * True when `toolKey` names the collector-wait tool: bare, MCP-namespaced
 * (`mcp__openclaw__agents_wait`), or flattened by a bridge relay
 * (`openclawagents_wait`, the same quirk as openclawread/openclawmemory_search
 * in composite-tools.ts / trust-levels.ts).
 */
export function isCollectorWaitTool(toolKey: string): boolean {
  const lower = toolKey.toLowerCase();
  const bare = stripKnownMcpPrefix(lower) ?? lower;
  return (
    bare === COLLECTOR_WAIT_TOOL_NAME ||
    bare === `openclaw${COLLECTOR_WAIT_TOOL_NAME}`
  );
}

/** The child session keys an agents_wait result actually collected. */
export function extractCollectedSessionKeys(result: unknown): string[] {
  const keys: string[] = [];
  for (const payload of candidatePayloads(result)) {
    const completed = (payload as { completed?: unknown }).completed;
    if (!Array.isArray(completed)) continue;
    for (const entry of completed) {
      const sessionKey = (entry as { sessionKey?: unknown } | null)?.sessionKey;
      if (typeof sessionKey === "string" && sessionKey.length > 0 && !keys.includes(sessionKey)) {
        keys.push(sessionKey);
      }
    }
    if (keys.length > 0) break;
  }
  return keys;
}

/**
 * Every shape the result may arrive in: the tool's own `details` payload, the
 * serialized `content[].text` the MCP path carries, and the raw object itself.
 * Same defensive ordering as the browser-result reader in index.ts.
 */
function* candidatePayloads(result: unknown): Generator<Record<string, unknown>> {
  if (!result || typeof result !== "object") return;
  const record = result as Record<string, unknown>;
  if (record.details && typeof record.details === "object") {
    yield record.details as Record<string, unknown>;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown } | null)?.text;
    if ((part as { type?: unknown }).type !== "text" || typeof text !== "string") continue;
    if (!text.includes('"completed"')) continue;
    for (const candidate of [text, text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
      if (!candidate) continue;
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") yield parsed as Record<string, unknown>;
        break;
      } catch {
        // Try the next candidate slice.
      }
    }
  }
  yield record;
}

export interface CollectorChildTaint {
  /** Max taint over the collected children; "trusted" when none resolved. */
  trust: TrustLevel;
  /** Child session keys read off the result, in result order. */
  sessionKeys: string[];
  /** The per-child levels actually found, parallel to sessionKeys. */
  levels: TrustLevel[];
}

/**
 * Fold the collected children's taint into one level.
 *
 * `lookup` returns a child's own taint, or undefined when the child has no
 * live graph and no watermark — which, per the module header, means it never
 * rose above trusted.
 */
export function resolveCollectorChildTaint(
  result: unknown,
  lookup: (sessionKey: string) => TrustLevel | undefined,
): CollectorChildTaint {
  const sessionKeys = extractCollectedSessionKeys(result);
  const levels = sessionKeys.map((key) => lookup(key) ?? "trusted");
  const trust = levels.reduce<TrustLevel>((acc, level) => minTrust(acc, level), "trusted");
  return { trust, sessionKeys, levels };
}
