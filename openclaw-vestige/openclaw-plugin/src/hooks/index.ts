/**
 * Hook registration for Vestige plugin.
 *
 * Registers before_prompt_build (memory retrieval) and llm_output
 * (memory ingestion) handlers powered by local DeBERTa NLI zero-shot
 * classification.
 *
 * Migrated from before_llm_call/after_llm_call (removed from openclaw
 * mainline as part of Vincent's split hook model).
 */

export { createBeforePromptBuildHandler } from "./before-prompt-build.js";
export { createLlmOutputHandler } from "./llm-output.js";
export { scoreConcepts, ensureInitialized, isInitialized, hasSalientConcepts, getSalientLabels } from "./nli-scorer.js";
export type { ConceptScore } from "./nli-scorer.js";
export { addToWindow, getRecentContext, getLastUserMessage, clearWindow, activeWindowCount } from "./sliding-window.js";
