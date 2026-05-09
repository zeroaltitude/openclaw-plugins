/**
 * Hook registration for Vestige plugin.
 *
 * Registers before_prompt_build (memory retrieval, redesigned around
 * referent extraction — see ./referent/) and llm_output (memory
 * ingestion, still NLI-driven on the user→assistant exchange).
 */

export { createBeforePromptBuildHandler } from "./before-prompt-build.js";
export { createLlmOutputHandler } from "./llm-output.js";
export {
  scoreConcepts,
  ensureInitialized,
  isInitialized,
  hasSalientConcepts,
  getSalientLabels,
} from "./nli-scorer.js";
export type { ConceptScore } from "./nli-scorer.js";
export {
  addToWindow,
  getRecentContext,
  getLastUserMessage,
  clearWindow,
  activeWindowCount,
} from "./sliding-window.js";
export {
  extractReferents,
  buildSearchQuery,
  pickMemoryTag,
  shouldSearchMemory,
  Gazetteer,
  getGazetteer,
  ensureGazetteerForWorkspace,
  extractKeyphrases,
  ensureEmbedderInitialized,
  isEmbedderInitialized,
} from "./referent/index.js";
export type { Referent, ReferentType, ExtractedReferent } from "./referent/index.js";
