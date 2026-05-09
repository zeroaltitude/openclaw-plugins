/**
 * KeyBERT-style keyphrase extractor.
 *
 * Generates 1–3 word candidate spans from `text`, embeds each with a
 * sentence-transformer model, and ranks them by cosine similarity to the
 * whole-message embedding. The high-similarity outliers are likely
 * proper nouns / referents the gazetteer hasn't seen yet.
 *
 * Uses @xenova/transformers feature-extraction pipeline with
 * Xenova/all-MiniLM-L6-v2 (~25MB quantized). Model loads lazily on first
 * call and is cached at module level.
 */

// @ts-ignore — @xenova/transformers ships partial types and is loaded via Node's ESM interop
import { pipeline, env } from "@xenova/transformers";

env.allowLocalModels = false;

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

let embedder: any = null;
let initPromise: Promise<void> | null = null;

async function initEmbedder(): Promise<void> {
  embedder = await pipeline("feature-extraction", EMBED_MODEL, {
    quantized: true,
  });
}

export async function ensureEmbedderInitialized(): Promise<void> {
  if (embedder) return;
  if (!initPromise) {
    initPromise = initEmbedder().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export function isEmbedderInitialized(): boolean {
  return embedder !== null;
}

export interface KeyphraseOptions {
  /** Maximum n in n-gram candidates (default: 3) */
  maxNgram?: number;
  /** Minimum cosine similarity threshold (default: 0.4) */
  minScore?: number;
  /** Maximum number of keyphrases to return (default: 5) */
  topK?: number;
  /** Stopword set used to drop trivial single-word candidates */
  stopwords?: Set<string>;
}

export interface Keyphrase {
  text: string;
  score: number;
}

const DEFAULT_STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","else","of","in","on","at","to","for",
  "by","with","from","as","is","are","was","were","be","been","being","have","has",
  "had","do","does","did","this","that","these","those","i","me","my","you","your",
  "we","our","they","their","he","she","it","its","not","no","yes","so","just","only",
  "can","could","would","should","will","may","might","must","up","down","out","off",
  "over","under","again","further","more","less","very","really","like","about","into",
  "through","there","here","when","where","why","how","what","which","who","whom",
  "while","also","still","than","because","why","such","some","any","all","each","every",
]);

function tokenize(text: string): string[] {
  // simple word tokenizer: keep alnum, dashes, dots inside tokens
  return (text.match(/[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*/g) ?? []);
}

function generateNgrams(tokens: string[], maxN: number, stopwords: Set<string>): string[] {
  const cands = new Set<string>();
  const lower = tokens.map((t) => t.toLowerCase());
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i <= tokens.length - n; i++) {
      const span = tokens.slice(i, i + n);
      const lspan = lower.slice(i, i + n);
      // Reject spans that are entirely stopwords or start/end with stopwords (n>1)
      if (n === 1) {
        if (stopwords.has(lspan[0])) continue;
        // Skip tokens that look like trivial words — require >= 3 chars OR mixed case / has digit
        if (
          span[0].length < 3 &&
          !/[A-Z]/.test(span[0]) &&
          !/\d/.test(span[0])
        )
          continue;
      } else {
        if (stopwords.has(lspan[0]) || stopwords.has(lspan[lspan.length - 1])) continue;
      }
      cands.add(span.join(" "));
    }
  }
  return Array.from(cands);
}

function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(text: string): Promise<Float32Array> {
  const out = await embedder(text, { pooling: "mean", normalize: true });
  // out is a Tensor — `.data` is a typed array
  return out.data as Float32Array;
}

/**
 * Extract keyphrases from text via embedding similarity.
 * Returns ranked phrases with cosine scores, filtered by `minScore`.
 */
export async function extractKeyphrases(
  text: string,
  opts: KeyphraseOptions = {},
): Promise<Keyphrase[]> {
  const trimmed = (text ?? "").trim();
  if (trimmed.length < 5) return [];
  const maxN = opts.maxNgram ?? 3;
  const minScore = opts.minScore ?? 0.4;
  const topK = opts.topK ?? 5;
  const stopwords = opts.stopwords ?? DEFAULT_STOPWORDS;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return [];
  const candidates = generateNgrams(tokens, maxN, stopwords);
  if (candidates.length === 0) return [];

  await ensureEmbedderInitialized();

  const docVec = await embed(trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed);

  const scored: Keyphrase[] = [];
  // Embed each candidate. For runtime sanity, cap candidates to 64.
  const capped = candidates.slice(0, 64);
  for (const cand of capped) {
    let candVec: Float32Array;
    try {
      candVec = await embed(cand);
    } catch {
      continue;
    }
    const score = cosine(docVec, candVec);
    if (score >= minScore) scored.push({ text: cand, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // De-duplicate sub-spans: if a longer candidate contains a shorter one
  // with similar score, prefer the longer one.
  const out: Keyphrase[] = [];
  for (const s of scored) {
    const dup = out.find(
      (o) => o.text.toLowerCase().includes(s.text.toLowerCase()) && o.score >= s.score - 0.05,
    );
    if (dup) continue;
    out.push(s);
    if (out.length >= topK) break;
  }
  return out;
}
