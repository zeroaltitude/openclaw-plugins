/**
 * NLI-based saliency scorer — replaces both llm-scorer.ts and saliency-gate.ts.
 *
 * Uses DeBERTa-v3-xsmall via @xenova/transformers zero-shot-classification
 * pipeline to classify messages against concept labels. No external API calls.
 *
 * ~22MB quantized model, runs locally on CPU. First call downloads the model
 * and takes a few seconds; subsequent calls are ~50-200ms depending on text length.
 */

// @ts-expect-error — @xenova/transformers has no TS types
import { pipeline, env } from "@xenova/transformers";

// ── Config ─────────────────────────────────────────────────────────────

/** Disable local model check — always use HF cache */
env.allowLocalModels = false;

const MODEL_NAME = "Xenova/nli-deberta-v3-xsmall";

// ── Types ──────────────────────────────────────────────────────────────

export interface ConceptScore {
  label: string;
  score: number;
}

// ── Default labels ─────────────────────────────────────────────────────

export const DEFAULT_CONCEPT_LABELS = [
  "personal fact",
  "preference",
  "decision",
  "task instruction",
  "technical concept",
  "commitment or promise",
  "casual greeting",
  "acknowledgment",
];

/** Labels that indicate non-salient content (excluded from saliency check) */
export const NON_SALIENT_LABELS = new Set(["casual greeting", "acknowledgment"]);

// ── Singleton state ────────────────────────────────────────────────────

let classifier: any = null;
let initPromise: Promise<void> | null = null;

// ── Initialization ─────────────────────────────────────────────────────

async function initClassifier(): Promise<void> {
  classifier = await pipeline("zero-shot-classification", MODEL_NAME, {
    quantized: true,
  });
}

/**
 * Ensure the model is loaded. Safe to call multiple times — only initializes once.
 */
export async function ensureInitialized(): Promise<void> {
  if (classifier) return;
  if (!initPromise) {
    initPromise = initClassifier().catch((err) => {
      initPromise = null; // Allow retry on failure
      throw err;
    });
  }
  return initPromise;
}

/**
 * Check if the classifier is loaded (for health checks / monitoring).
 */
export function isInitialized(): boolean {
  return classifier !== null;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Score text against concept labels using zero-shot NLI classification.
 *
 * @param text - The text to classify
 * @param labels - Concept labels to score against (defaults to DEFAULT_CONCEPT_LABELS)
 * @returns Array of { label, score } sorted by score descending
 */
export async function scoreConcepts(
  text: string,
  labels?: string[],
): Promise<ConceptScore[]> {
  await ensureInitialized();

  const conceptLabels = labels ?? DEFAULT_CONCEPT_LABELS;

  // Truncate very long texts to keep inference fast
  const truncated = text.length > 512 ? text.slice(0, 512) : text;

  const result = await classifier(truncated, conceptLabels, {
    multi_label: true,
  });

  // The pipeline returns { sequence, labels, scores } — zip labels and scores
  const scores: ConceptScore[] = [];
  for (let i = 0; i < result.labels.length; i++) {
    scores.push({
      label: result.labels[i],
      score: result.scores[i],
    });
  }

  // Already sorted by score descending from the pipeline, but ensure it
  scores.sort((a, b) => b.score - a.score);

  return scores;
}

/**
 * Check if any salient concepts are above threshold.
 * Excludes non-salient labels (casual greeting, acknowledgment) from the check.
 */
export function hasSalientConcepts(
  scores: ConceptScore[],
  threshold: number = 0.5,
): boolean {
  return scores.some(
    (s) => s.score >= threshold && !NON_SALIENT_LABELS.has(s.label),
  );
}

/**
 * Get the salient concept labels (above threshold, excluding non-salient).
 */
export function getSalientLabels(
  scores: ConceptScore[],
  threshold: number = 0.5,
): string[] {
  return scores
    .filter((s) => s.score >= threshold && !NON_SALIENT_LABELS.has(s.label))
    .map((s) => s.label);
}
