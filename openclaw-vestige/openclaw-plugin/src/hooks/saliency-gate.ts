/**
 * Bi-encoder saliency gate — fast pre-filter before the LLM scorer.
 *
 * Uses all-MiniLM-L6-v2 via @xenova/transformers (ONNX, in-process)
 * to embed messages and score against dual centroids:
 *
 *   - Low-value centroid: "hey", "thanks", "ok", etc.
 *     Messages close to this → skip (no LLM scorer needed)
 *   - High-value centroid: "remember this", "my preference is", etc.
 *     Messages close to this → definitely score (bypass gate)
 *   - Ambiguous middle → pass to LLM scorer for nuanced evaluation
 *
 * Adds ~5-10ms per turn on CPU. Model downloaded lazily on first use (~80MB).
 */

// @ts-expect-error — @xenova/transformers has no TS types
import { pipeline, env } from "@xenova/transformers";

// ── Config ─────────────────────────────────────────────────────────────

/** Disable local model check — always use HF cache */
env.allowLocalModels = false;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

// ── Seed messages for centroid computation ──────────────────────────────
// These define what "low value" and "high value" look like semantically.
// The centroids are computed once at init by averaging embeddings.

const LOW_VALUE_SEEDS = [
  "hey",
  "hi",
  "hello",
  "thanks",
  "thank you",
  "ok",
  "okay",
  "sure",
  "yes",
  "no",
  "yep",
  "nope",
  "cool",
  "nice",
  "great",
  "lol",
  "haha",
  "😂",
  "👍",
  "👋",
  "sounds good",
  "got it",
  "k",
  "kk",
  "np",
  "no problem",
  "you're welcome",
  "welcome",
  "good morning",
  "good night",
  "bye",
  "see you",
  "ttyl",
  "brb",
  "same",
  "agreed",
  "yea",
  "nah",
  "hmm",
  "huh",
  "wow",
  "oh",
  "ah",
  "right",
  "exactly",
  "totally",
  "for sure",
  "definitely",
  "absolutely",
  "perfect",
];

const HIGH_VALUE_SEEDS = [
  "remember this",
  "don't forget",
  "my preference is",
  "I always want",
  "the decision was",
  "we decided to",
  "important: from now on",
  "never do this again",
  "my anniversary is",
  "my birthday is",
  "the password is",
  "the API key is",
  "save this for later",
  "remember my name is",
  "I prefer it when you",
  "please always",
  "please never",
  "the rule is",
  "going forward",
  "key takeaway",
  "lesson learned",
  "the fix was",
  "root cause was",
  "the architecture is",
  "we agreed on",
];

// ── Types ──────────────────────────────────────────────────────────────

export type GateResult = {
  /** Whether the message should be passed to the LLM scorer */
  passToScorer: boolean;
  /** Reason for the gate decision */
  reason: "low-value" | "high-value" | "ambiguous";
  /** Distance from low-value centroid (higher = more interesting) */
  lowDist: number;
  /** Distance from high-value centroid (lower = more important) */
  highDist: number;
};

export interface GateConfig {
  /** Max cosine distance from low-value centroid to be considered noise (default: 0.3) */
  lowValueThreshold?: number;
  /** Max cosine distance from high-value centroid to be considered important (default: 0.4) */
  highValueThreshold?: number;
}

// ── Singleton state ────────────────────────────────────────────────────

let embedder: any = null;
let lowCentroid: Float32Array | null = null;
let highCentroid: Float32Array | null = null;
let initPromise: Promise<void> | null = null;

// ── Math helpers ───────────────────────────────────────────────────────

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
  return 1 - sim; // distance: 0 = identical, 2 = opposite
}

function averageVectors(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error("Cannot average empty vector list");
  const dim = vectors[0].length;
  const avg = new Float32Array(dim);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      avg[i] += vec[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    avg[i] /= vectors.length;
  }
  return avg;
}

// ── Initialization ─────────────────────────────────────────────────────

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (!embedder) {
    embedder = await pipeline("feature-extraction", MODEL_NAME, {
      quantized: true, // Use quantized ONNX model for speed
    });
  }

  const results: Float32Array[] = [];
  // Process in small batches to avoid memory spikes
  const batchSize = 16;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await embedder(batch, { pooling: "mean", normalize: true });
    for (let j = 0; j < batch.length; j++) {
      results.push(new Float32Array(output[j].data));
    }
  }
  return results;
}

async function initCentroids(): Promise<void> {
  const lowEmbeddings = await embedTexts(LOW_VALUE_SEEDS);
  const highEmbeddings = await embedTexts(HIGH_VALUE_SEEDS);
  lowCentroid = averageVectors(lowEmbeddings);
  highCentroid = averageVectors(highEmbeddings);
}

/**
 * Ensure the model is loaded and centroids are computed.
 * Safe to call multiple times — only initializes once.
 */
export async function ensureInitialized(): Promise<void> {
  if (lowCentroid && highCentroid) return;
  if (!initPromise) {
    initPromise = initCentroids().catch((err) => {
      initPromise = null; // Allow retry on failure
      throw err;
    });
  }
  return initPromise;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Score a message against dual centroids to decide if it needs LLM scoring.
 *
 * Returns quickly (~5-10ms after init) with a gate decision:
 * - low-value: skip the LLM scorer entirely
 * - high-value: definitely pass to LLM scorer (or skip scorer and go straight to retrieve/store)
 * - ambiguous: pass to LLM scorer for nuanced evaluation
 */
export async function scoreGate(
  message: string,
  config?: GateConfig,
): Promise<GateResult> {
  await ensureInitialized();

  const lowThreshold = config?.lowValueThreshold ?? 0.3;
  const highThreshold = config?.highValueThreshold ?? 0.4;

  const [embedding] = await embedTexts([message]);

  const lowDist = cosineDistance(embedding, lowCentroid!);
  const highDist = cosineDistance(embedding, highCentroid!);

  // Close to low-value centroid → skip
  if (lowDist < lowThreshold) {
    return { passToScorer: false, reason: "low-value", lowDist, highDist };
  }

  // Close to high-value centroid → definitely score
  if (highDist < highThreshold) {
    return { passToScorer: true, reason: "high-value", lowDist, highDist };
  }

  // Ambiguous → let the LLM scorer decide
  return { passToScorer: true, reason: "ambiguous", lowDist, highDist };
}

/**
 * Check if the gate is initialized (for health checks / monitoring).
 */
export function isInitialized(): boolean {
  return lowCentroid !== null && highCentroid !== null;
}
