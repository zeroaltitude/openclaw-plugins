import { describe, it, expect } from "vitest";
import {
  getToolTrust,
  buildToolOutputTaintMap,
  DEFAULT_TOOL_OUTPUT_TAINTS,
} from "../trust-levels.js";

const taints = buildToolOutputTaintMap({});

// Harness-native scheduling / orchestration / lifecycle primitives. Their
// output is agent-local state, schedule/confirmation metadata, or an action
// ack — none crosses an external trust boundary. An unmapped entry here
// defaults to "untrusted", which silently taints the session and gates
// downstream tools (e.g. `message`). These regression-guard that the whole
// class stays trusted. See the ScheduleWakeup-tainted-session incident.
const HARNESS_NATIVE_TRUSTED = [
  "ScheduleWakeup",
  "Workflow",
  "DesignSync",
  "ShareOnboardingGuide",
  "spawn_agent",
  // siblings already mapped — included so the class is asserted as a unit
  "CronCreate",
  "Monitor",
  "PushNotification",
  "TaskOutput",
  "EnterWorktree",
] as const;

describe("harness-native primitives — trusted output", () => {
  for (const tool of HARNESS_NATIVE_TRUSTED) {
    it(`${tool} resolves trusted (bare)`, () => {
      expect(getToolTrust(tool, taints)).toBe("trusted");
    });

    it(`${tool} resolves trusted via the openclaw MCP bridge prefix`, () => {
      expect(getToolTrust(`mcp__openclaw__${tool}`, taints)).toBe("trusted");
    });
  }

  it("each harness-native primitive has an explicit default entry (not relying on the prefix fallback)", () => {
    for (const tool of HARNESS_NATIVE_TRUSTED) {
      expect(DEFAULT_TOOL_OUTPUT_TAINTS[tool]).toBe("trusted");
    }
  });

  it("genuine web tools remain untrusted (guard against over-trusting)", () => {
    expect(getToolTrust("WebFetch", taints)).toBe("untrusted");
    expect(getToolTrust("web_fetch", taints)).toBe("untrusted");
    expect(getToolTrust("browser", taints)).toBe("untrusted");
  });
});

const VESTIGE_TRUSTED_ALIASES = [
  "vestige_backup",
  "openclawvestige_dream",
  "openclawvestige_consolidate",
  "openclawvestige_backup",
] as const;

describe("Vestige dynamic-tool aliases — trusted output", () => {
  for (const tool of VESTIGE_TRUSTED_ALIASES) {
    it(`${tool} resolves trusted`, () => {
      expect(getToolTrust(tool, taints)).toBe("trusted");
    });

    it(`${tool} has an explicit default entry`, () => {
      expect(DEFAULT_TOOL_OUTPUT_TAINTS[tool]).toBe("trusted");
    });
  }
});
