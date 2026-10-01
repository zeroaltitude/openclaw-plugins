import { describe, it, expect } from "vitest";
import {
  getToolTrust,
  bridgeToolName,
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

// The CLI bridge's names (openclaw-provenance-0kz). OpenClaw's claude-cli
// bridge reports a native tool under its policy id: CamelCase split into
// snake_case, lowercased, then aliased (bash -> exec, cron -> automations).
// Claude Code's TaskStop reached provenance as `task_stop`, missed every
// lookup, and tainted a Theseus lane's session untrusted (2026-09-30).
describe("CLI bridge tool names — the bridge's form of a known key", () => {
  it("mirrors openclaw's normalizeCliToolName", () => {
    expect(bridgeToolName("TaskStop")).toBe("task_stop");
    expect(bridgeToolName("AskUserQuestion")).toBe("ask_user_question");
    expect(bridgeToolName("ListMcpResourcesTool")).toBe("list_mcp_resources_tool");
    expect(bridgeToolName("MCPTool")).toBe("mcp_tool");
    expect(bridgeToolName("WebFetch")).toBe("web_fetch");
    expect(bridgeToolName("Bash")).toBe("exec");
    expect(bridgeToolName("cron")).toBe("automations");
    expect(bridgeToolName("sessions_spawn")).toBe("sessions_spawn");
  });

  it("the watermark's own name, task_stop, resolves trusted", () => {
    expect(getToolTrust("task_stop", taints)).toBe("trusted");
    expect(getToolTrust("task_stop")).toBe("trusted");
  });

  it("every multi-word key resolves, in its bridge form, exactly as the key does", () => {
    const multiWord = Object.keys(DEFAULT_TOOL_OUTPUT_TAINTS).filter((key) =>
      /[a-z0-9][A-Z]/.test(key),
    );
    expect(multiWord.length).toBeGreaterThan(20);
    for (const key of multiWord) {
      expect([key, getToolTrust(bridgeToolName(key), taints)]).toEqual([
        key,
        getToolTrust(key, taints),
      ]);
    }
  });

  it("the cron tool under its policy name, automations, is trusted", () => {
    expect(getToolTrust("automations", taints)).toBe("trusted");
  });

  it("the web tools stay untrusted in their bridge form", () => {
    expect(getToolTrust("web_fetch", taints)).toBe("untrusted");
    expect(getToolTrust("web_search", taints)).toBe("untrusted");
  });

  it("a name no known key folds to stays untrusted", () => {
    expect(getToolTrust("task_stopper", taints)).toBe("untrusted");
    expect(getToolTrust("taskstop_now", taints)).toBe("untrusted");
    expect(getToolTrust("unknown_widget", taints)).toBe("untrusted");
  });

  it("an override keeps its say over the bridge form", () => {
    const strict = buildToolOutputTaintMap({ TaskStop: "untrusted" });
    expect(getToolTrust("task_stop", strict)).toBe("untrusted");
  });

  it("when two keys share a bridge form, the less trusted wins", () => {
    // TASKStop folds to task_stop too, and neither key matches it case-insensitively.
    const clash = buildToolOutputTaintMap({ TaskStop: "trusted", TASKStop: "external" });
    expect(getToolTrust("task_stop", clash)).toBe("external");
  });
});
