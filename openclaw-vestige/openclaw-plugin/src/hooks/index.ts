/**
 * Hook registration for Vestige plugin.
 *
 * Registers before_llm_call (memory retrieval) and after_llm_call
 * (memory ingestion) handlers powered by a cheap LLM saliency scorer.
 */

export { createBeforeLlmCallHandler } from "./before-llm-call.js";
export { createAfterLlmCallHandler } from "./after-llm-call.js";
export { scoreInbound, scoreOutbound } from "./llm-scorer.js";
export type { SaliencyScore, ScorerConfig } from "./llm-scorer.js";
export { addToWindow, getRecentContext, getLastUserMessage, clearWindow, activeWindowCount } from "./sliding-window.js";
