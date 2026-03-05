/**
 * Hook registration for Vestige plugin.
 *
 * Registers before_llm_call (memory retrieval) and after_llm_call
 * (memory ingestion) handlers powered by local DeBERTa NLI zero-shot classification.
 */

export { createBeforeLlmCallHandler } from "./before-llm-call.js";
export { createAfterLlmCallHandler } from "./after-llm-call.js";
export { scoreConcepts, ensureInitialized, isInitialized, hasSalientConcepts, getSalientLabels } from "./nli-scorer.js";
export type { ConceptScore } from "./nli-scorer.js";
export { addToWindow, getRecentContext, getLastUserMessage, clearWindow, activeWindowCount } from "./sliding-window.js";
