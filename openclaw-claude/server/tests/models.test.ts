import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MODELS,
  isKnownModel,
  requiresAlwaysOnThinking,
  thinkingBudgetForEffort,
} from "../src/models.js";

describe("ANTHROPIC_MODELS catalog", () => {
  it("recognizes claude-opus-4-8 and claude-fable-5", () => {
    expect(isKnownModel("claude-opus-4-8")).toBe(true);
    expect(isKnownModel("claude-fable-5")).toBe(true);
  });

  it("does not offer none/minimal reasoning effort for claude-fable-5", () => {
    const fable5 = ANTHROPIC_MODELS.find((m) => m.id === "claude-fable-5");
    expect(fable5).toBeDefined();
    const efforts = fable5!.supportedReasoningEfforts.map((o) => o.reasoningEffort);
    expect(efforts).not.toContain("none");
    expect(efforts).not.toContain("minimal");
    expect(fable5!.defaultReasoningEffort).not.toBe("none");
  });
});

describe("requiresAlwaysOnThinking", () => {
  it("is true only for claude-fable-5", () => {
    expect(requiresAlwaysOnThinking("claude-fable-5")).toBe(true);
    expect(requiresAlwaysOnThinking("claude-opus-4-8")).toBe(false);
    expect(requiresAlwaysOnThinking("claude-opus-4-7")).toBe(false);
    expect(requiresAlwaysOnThinking(undefined)).toBe(false);
  });
});

describe("thinking config resolution (regression: fable-5 400)", () => {
  // Mirrors turn-runner.ts's runTurn exactly. Anthropic's own 400 message
  // says thinking defaults to adaptive mode when NOT specified — omitting
  // the thinking param is how a caller asks for model-default behavior, and
  // is NOT equivalent to explicitly disabling it. Any unresolved effort
  // (including OpenClaw's "adaptive"/"max" thinkLevels, which this bridge's
  // ReasoningEffort enum has no equivalent for) must omit thinking, not
  // silently become thinking.type="disabled" — that's what a hard-rejects
  // for claude-fable-5 specifically, even though most models tolerate it.
  type ThinkingConfig = { type: "disabled" } | { type: "enabled"; budgetTokens: number } | undefined;
  function resolveThinking(model: string, effort: string | null): ThinkingConfig {
    const explicitlyDisabled = effort === "none" || effort === "minimal";
    const resolvedBudget = thinkingBudgetForEffort(effort as never);
    if (requiresAlwaysOnThinking(model)) {
      return { type: "enabled", budgetTokens: resolvedBudget ?? thinkingBudgetForEffort("low")! };
    }
    if (explicitlyDisabled) return { type: "disabled" };
    if (resolvedBudget !== null) return { type: "enabled", budgetTokens: resolvedBudget };
    return undefined;
  }

  it("forces a real enabled budget for claude-fable-5 even with no effort", () => {
    expect(resolveThinking("claude-fable-5", null)).toEqual({ type: "enabled", budgetTokens: 1_024 });
  });

  it("forces a real enabled budget for claude-fable-5 even if none/minimal was explicitly requested", () => {
    expect(resolveThinking("claude-fable-5", "none")).toEqual({ type: "enabled", budgetTokens: 1_024 });
    expect(resolveThinking("claude-fable-5", "minimal")).toEqual({ type: "enabled", budgetTokens: 1_024 });
  });

  it("forces a real enabled budget for claude-fable-5 given an unrecognized effort string (adaptive/max)", () => {
    expect(resolveThinking("claude-fable-5", "adaptive")).toEqual({ type: "enabled", budgetTokens: 1_024 });
    expect(resolveThinking("claude-fable-5", "max")).toEqual({ type: "enabled", budgetTokens: 1_024 });
  });

  it("still disables thinking for explicit none/minimal on models that support disabling it", () => {
    expect(resolveThinking("claude-opus-4-8", "none")).toEqual({ type: "disabled" });
    expect(resolveThinking("claude-haiku-4-5", "minimal")).toEqual({ type: "disabled" });
  });

  it("omits thinking entirely (not disabled) when no effort is specified for a normal model", () => {
    expect(resolveThinking("claude-opus-4-8", null)).toBeUndefined();
    expect(resolveThinking("claude-opus-4-7", "adaptive")).toBeUndefined();
  });

  it("still applies a real budget when a normal model has a resolvable effort", () => {
    expect(resolveThinking("claude-opus-4-7", "high")).toEqual({ type: "enabled", budgetTokens: 32_000 });
  });
});
