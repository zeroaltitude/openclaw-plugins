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

// Local project-analysis tools (understand_*). Read-only, agent-local — but
// on the native Claude Code harness they arrive under BARE names (no
// mcp__openclaw__ prefix), so an unmapped entry falls through getToolTrust()'s
// prefix fallback to the "untrusted" secure-default. That silently re-taints
// the session on every read-only call and overrides /reset-trust +
// /approve-exec approvals on the next turn (the openclaw-provenance-nxf bug).
// These guard that the whole family stays trusted whether called bare (native
// harness) or MCP-prefixed (bridge). Same class as c69e13f "local tool taints".
const UNDERSTAND_TRUSTED = [
  "understand_status",
  "understand_search",
  "understand_analyze_project",
  "understand_get_node",
  "understand_list_projects",
] as const;

describe("understand_* local project-analysis tools — trusted output", () => {
  for (const tool of UNDERSTAND_TRUSTED) {
    it(`${tool} resolves trusted when called bare (native harness)`, () => {
      // The failing behavior before the fix: a bare understand_* name missed
      // every branch of getToolTrust() and returned the "untrusted" default.
      expect(getToolTrust(tool, taints)).toBe("trusted");
    });

    it(`${tool} resolves trusted via the openclaw MCP bridge prefix`, () => {
      expect(getToolTrust(`mcp__openclaw__${tool}`, taints)).toBe("trusted");
    });

    it(`${tool} has an explicit default entry (not relying on the prefix fallback)`, () => {
      expect(DEFAULT_TOOL_OUTPUT_TAINTS[tool]).toBe("trusted");
    });
  }
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
