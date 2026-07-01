/**
 * Anthropic Claude model catalog projected onto codex's Model shape.
 *
 * The codex protocol's ReasoningEffort enum is OpenAI-flavored
 * (none/minimal/low/medium/high/xhigh). Anthropic's extended thinking is
 * controlled by a token budget, not a discrete enum, so we synthesize
 * reasonable effort buckets per model and map them at turn/start time:
 *
 *   none    → thinking disabled
 *   minimal → thinking disabled (alias for none)
 *   low     → ~ 1,024-token budget
 *   medium  → ~ 8,192-token budget
 *   high    → ~ 32,000-token budget
 *   xhigh   → ~ 65,536-token budget (max in current Anthropic docs)
 *
 * Sources of truth for IDs and context windows: the user's openclaw.json
 * provider.anthropic.models list and Anthropic's public model docs.
 */

import type { Model, ModelListResponse, ReasoningEffort, ReasoningEffortOption } from "./protocol.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic";

const REASONING_EFFORTS_DEFAULT: ReasoningEffortOption[] = [
  { reasoningEffort: "low", description: "Brief thinking budget (~1k tokens)" },
  { reasoningEffort: "medium", description: "Standard thinking budget (~8k tokens)" },
  { reasoningEffort: "high", description: "Long thinking budget (~32k tokens)" },
  { reasoningEffort: "xhigh", description: "Maximum thinking budget (~64k tokens)" },
];

const REASONING_EFFORTS_NONE: ReasoningEffortOption[] = [
  { reasoningEffort: "none", description: "No extended thinking" },
];

export const ANTHROPIC_MODELS: Model[] = [
  {
    id: "claude-opus-4-7",
    model: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    description: "Anthropic's highest-capability model; 1M-token context, extended thinking, vision.",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: REASONING_EFFORTS_DEFAULT,
    inputModalities: ["text", "image"],
  },
  {
    id: "claude-opus-4-6",
    model: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    description: "Previous-generation Opus; 1M-token context, extended thinking, vision.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: REASONING_EFFORTS_DEFAULT,
    inputModalities: ["text", "image"],
  },
  {
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    description: "Mid-tier balance of capability and latency; 200k context, extended thinking, vision.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: REASONING_EFFORTS_DEFAULT,
    inputModalities: ["text", "image"],
  },
  {
    id: "claude-haiku-4-5",
    model: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    description: "Fastest, lowest-cost model; 200k context, vision. Does not support extended thinking.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "none",
    supportedReasoningEfforts: REASONING_EFFORTS_NONE,
    inputModalities: ["text", "image"],
  },
  {
    id: "claude-opus-4-8",
    model: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    description: "Latest-generation Opus; 1M-token context, extended thinking, vision.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: REASONING_EFFORTS_DEFAULT,
    inputModalities: ["text", "image"],
  },
  {
    id: "claude-fable-5",
    model: "claude-fable-5",
    displayName: "Claude Fable 5",
    description:
      "Preview model with always-on adaptive extended thinking; 1M-token context, vision. " +
      "Unlike other Claude models, the Anthropic API rejects thinking.type=disabled for this " +
      "model outright, so \"none\"/\"minimal\" are deliberately not offered here — see " +
      "MODELS_REQUIRING_THINKING below, which forces a real budget even if a caller somehow " +
      "requests a disabled/unrecognized effort anyway.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: REASONING_EFFORTS_DEFAULT,
    inputModalities: ["text", "image"],
  },
];

/**
 * Model IDs that cannot accept thinking.type="disabled" at all — the Anthropic
 * API hard-rejects the request (400 "thinking.type.disabled is not supported
 * for this model"). Keyed by model, not by reasoning-effort string, because
 * callers upstream (OpenClaw core) may pass effort values outside this
 * bridge's own ReasoningEffort enum (e.g. "adaptive"/"max" from core's newer
 * thinking-level vocabulary) — those fall through thinkingBudgetForEffort's
 * default case to null/disabled just like "none" would. Checking the model
 * directly in runTurn (turn-runner.ts) catches every such case, not just the
 * ones spelled "none"/"minimal".
 */
const MODELS_REQUIRING_THINKING = new Set<string>(["claude-fable-5"]);

export function requiresAlwaysOnThinking(modelId: string | undefined): boolean {
  return !!modelId && MODELS_REQUIRING_THINKING.has(modelId);
}

export function buildModelListResponse(): ModelListResponse {
  return { data: ANTHROPIC_MODELS, nextCursor: null };
}

export function isKnownModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return ANTHROPIC_MODELS.some((m) => m.id === modelId);
}

export function defaultModelId(): string {
  const def = ANTHROPIC_MODELS.find((m) => m.isDefault);
  return def?.id ?? ANTHROPIC_MODELS[0]!.id;
}

/**
 * Map codex's ReasoningEffort enum to an Anthropic thinking-budget token count.
 * Returns null for "none"/"minimal" (thinking disabled).
 */
export function thinkingBudgetForEffort(effort: ReasoningEffort | null | undefined): number | null {
  switch (effort) {
    case "low":
      return 1_024;
    case "medium":
      return 8_192;
    case "high":
      return 32_000;
    case "xhigh":
      return 65_536;
    default:
      return null;
  }
}
