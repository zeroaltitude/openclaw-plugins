/**
 * Layered referent extraction for vestige's before_prompt_build hook.
 *
 * Final stack (per openclaw-vestige-5fq):
 *   1. Regex layer       — structured ids (URLs, beads ids, paths, SHAs, dates, uids)
 *   2. Gazetteer layer   — auto-derived proper nouns (repos, plugins, agents)
 *   3. KeyBERT layer     — novel n-grams via sentence-embedding similarity
 *   4. NER layer         — escalation only, NOT implemented in v1
 *
 * Returns a deduped, type-tagged list of referents the search query
 * should target. Each referent surfaces a `value` we can drop into the
 * Vestige search query and a `type` we can use as a memory tag.
 *
 * TODO(openclaw-vestige-5fq): optional NER fallback if KeyBERT recall disappoints.
 */

import { extractRegexReferents, type Referent, type ReferentType } from "./regex.js";
import { Gazetteer, getGazetteer, type GazetteerEntry } from "./gazetteer.js";
import { extractKeyphrases } from "./keybert.js";

export type { Referent, ReferentType } from "./regex.js";
export { Gazetteer, getGazetteer } from "./gazetteer.js";
export { extractKeyphrases, ensureEmbedderInitialized, isEmbedderInitialized } from "./keybert.js";

export interface ExtractOptions {
  gazetteer?: Gazetteer;
  /** Enable KeyBERT layer (default: true). Set false in tests to avoid model load. */
  enableKeybert?: boolean;
  /** Maximum referents to return (default: 12) */
  maxReferents?: number;
  /** KeyBERT top-k (default: 4) */
  keybertTopK?: number;
  /** KeyBERT min cosine score (default: 0.4) */
  keybertMinScore?: number;
}

export interface ExtractedReferent {
  type: ReferentType | "gazetteer" | "keyphrase";
  /** Specific subtype (e.g. gazetteer/repo, gazetteer/agent) */
  subtype?: string;
  value: string;
  source: "regex" | "gazetteer" | "keybert";
  /** Optional cosine score for keybert results */
  score?: number;
}

const TRIVIAL_PATTERNS: RegExp[] =
  [
    /^(?:ok(?:ay)?|yes|no|nope|yep|yeah|sure|fine|cool|nice|great|thanks|thank you|ty|hi|hey|hello|hola|sup|lol|lmao|haha|wat|wut|huh)[\s!.?]*$/i,
    /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!?.,]+$/u,
  ];

/**
 * Cheap salience gate. Replaces the per-turn DeBERTa NLI pass.
 * Returns true if the message is worth searching memory for.
 */
export function shouldSearchMemory(userMessage: string): boolean {
  const trimmed = (userMessage ?? "").trim();
  if (trimmed.length < 10) return false;
  for (const re of TRIVIAL_PATTERNS) {
    if (re.test(trimmed)) return false;
  }
  return true;
}

/**
 * Extract referents from `text` using all enabled layers in parallel.
 */
export async function extractReferents(
  text: string,
  opts: ExtractOptions = {},
): Promise<ExtractedReferent[]> {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return [];
  const gz = opts.gazetteer ?? null;
  const enableKeybert = opts.enableKeybert ?? true;
  const maxReferents = opts.maxReferents ?? 12;

  const knownRepos = gz ? gz.repoNames() : undefined;

  const tasks: Array<Promise<ExtractedReferent[]>> = [];

  // 1. Regex
  tasks.push(
    Promise.resolve(
      extractRegexReferents(trimmed, knownRepos).map<ExtractedReferent>((r) => ({
        type: r.type,
        value: r.value,
        source: "regex",
      })),
    ),
  );

  // 2. Gazetteer
  if (gz) {
    tasks.push(
      Promise.resolve(
        gz.match(trimmed).map<ExtractedReferent>((g: GazetteerEntry) => ({
          type: "gazetteer",
          subtype: g.type,
          value: g.term,
          source: "gazetteer",
        })),
      ),
    );
  }

  // 3. KeyBERT (slowest; lazy model load)
  if (enableKeybert) {
    tasks.push(
      extractKeyphrases(trimmed, {
        topK: opts.keybertTopK ?? 4,
        minScore: opts.keybertMinScore ?? 0.4,
      })
        .then((phrases) =>
          phrases.map<ExtractedReferent>((p) => ({
            type: "keyphrase",
            value: p.text,
            score: p.score,
            source: "keybert",
          })),
        )
        .catch(() => []),
    );
  }

  const layered = await Promise.all(tasks);

  // Dedupe: prefer regex > gazetteer > keybert if values overlap (case-insensitive).
  const seen = new Map<string, ExtractedReferent>();
  const order: Record<ExtractedReferent["source"], number> = {
    regex: 3,
    gazetteer: 2,
    keybert: 1,
  };
  for (const arr of layered) {
    for (const r of arr) {
      const key = r.value.toLowerCase();
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, r);
        continue;
      }
      if (order[r.source] > order[existing.source]) {
        seen.set(key, r);
      }
    }
  }

  // Drop keybert phrases that are sub-strings of higher-priority referents
  const all = Array.from(seen.values());
  const filtered = all.filter((r) => {
    if (r.source !== "keybert") return true;
    return !all.some(
      (other) =>
        other !== r &&
        order[other.source] > order.keybert &&
        other.value.toLowerCase().includes(r.value.toLowerCase()),
    );
  });

  // Sort: regex first, then gazetteer, then keybert by score desc
  filtered.sort((a, b) => {
    if (a.source !== b.source) return order[b.source] - order[a.source];
    if (a.source === "keybert") return (b.score ?? 0) - (a.score ?? 0);
    return 0;
  });

  return filtered.slice(0, maxReferents);
}

/**
 * Build the Vestige search query string from user message + extracted
 * referents. The user message slice is the dense-retrieval anchor; the
 * referent values are appended (deduped) so the embedding pulls toward
 * specific entities, not topic centroids.
 */
export function buildSearchQuery(userMessage: string, refs: ExtractedReferent[]): string {
  const slice = userMessage.slice(0, 200);
  if (refs.length === 0) return slice;
  // Use distinct values, omitting any already present in the slice
  const lowerSlice = slice.toLowerCase();
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const v = r.value;
    const lv = v.toLowerCase();
    if (seen.has(lv)) continue;
    if (lowerSlice.includes(lv)) continue;
    seen.add(lv);
    extra.push(v);
  }
  if (extra.length === 0) return slice;
  return `${slice} ${extra.join(" ")}`.trim();
}

/**
 * Pick a memory-tag label for an injected memory line. Uses the most
 * specific extracted referent type, falling back to "memory".
 */
export function pickMemoryTag(refs: ExtractedReferent[]): string {
  if (refs.length === 0) return "memory";
  const r = refs[0];
  if (r.subtype) return `${r.subtype}:${r.value}`;
  return `${r.type}:${r.value}`;
}

/** Convenience: get just the singleton gazetteer with a workspace dir registered. */
export function ensureGazetteerForWorkspace(
  workspaceDir?: string,
  opts?: Parameters<typeof getGazetteer>[0],
): Gazetteer {
  const gz = getGazetteer(opts);
  if (workspaceDir) gz.addAgentWorkspace(workspaceDir);
  return gz;
}
