/**
 * Tool classification for the OpenClaw 2026.11.3 surface — openclaw-provenance-0ii.
 *
 * Part 1 pins a label on every tool name the 2026.11.3 gateway offers that had
 * no entry anywhere in this plugin and therefore took the unknown-tool
 * "untrusted" secure default.
 *
 * Part 2 replays the three lockouts seen in the gateway journal on 2026-11-12
 * through the real hook pipeline: a call escalated a trusted session to
 * untrusted, and every later tool call in that session was refused at the
 * execution layer. Each one asserts the escalation is gone AND that the
 * mechanism still escalates when a genuine source is involved.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSecurityHooks, type SecurityPluginConfig } from "../index.js";
import { makeApi } from "./test-shim.js";
import { getSharedWatermarkStore } from "../watermark-store.js";
import {
  buildToolOutputTaintMap,
  getToolTrust,
  type TrustLevel,
} from "../trust-levels.js";
import {
  buildCompositeToolMap,
  DEFAULT_COMPOSITE_OUTPUT_TAINTS,
  resolveToolKey,
} from "../composite-tools.js";

// The map production builds at startup (src/security/index.ts: composite
// output taints merged over the tool output taints).
const RESOLVED = buildToolOutputTaintMap({ ...DEFAULT_COMPOSITE_OUTPUT_TAINTS });
const COMPOSITES = buildCompositeToolMap();

function trustOf(toolName: string, params: Record<string, unknown> = {}): TrustLevel {
  return getToolTrust(resolveToolKey(toolName, params, COMPOSITES), RESOLVED);
}

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (...args: any[]) => logs.push(args.join(" ")),
    warn: (...args: any[]) => logs.push("WARN: " + args.join(" ")),
    error: (...args: any[]) => logs.push("ERROR: " + args.join(" ")),
    logs,
  };
}

// ── Part 1: the classification table ─────────────────────────────────────

describe("2026.11.3 tool names that had no entry", () => {
  const cases: Array<[name: string, expected: TrustLevel]> = [
    // Gateway-local state: sessions, schedules, panels, routes, local files.
    ["agents_wait", "trusted"], // fallback only; per-call value comes from the children
    ["ask_user", "trusted"],
    ["ls", "trusted"],
    ["sessions", "trusted"],
    ["sessions_create", "trusted"],
    ["presence", "trusted"],
    ["conversations_send", "trusted"],
    ["plugins", "trusted"],
    ["openclaw", "trusted"],
    ["portal", "trusted"],
    ["screen", "trusted"],
    ["terminal", "trusted"],
    ["dashboard", "trusted"],
    ["show_widget", "trusted"],
    ["theme", "trusted"],
    ["suggest_task", "trusted"],
    ["dismiss_task", "trusted"],
    ["decision_evaluate", "trusted"],
    ["personal_instructions", "trusted"],
    ["secrets", "trusted"],
    ["github_identity_status", "trusted"],
    ["github_publish", "trusted"],
    ["structured_output", "trusted"],
    ["tool_describe", "trusted"],
    ["dispatch_action", "trusted"],
    ["find", "trusted"],
    ["search", "trusted"],
    // Routing metadata about external channels.
    ["conversations_list", "shared"],
    // Content that came from outside this gateway.
    ["conversations_turn", "external"],
    ["skills_search", "external"],
    ["skills_read", "external"],
    ["skill_library", "external"],
    ["transcripts", "external"],
  ];

  it.each(cases)("%s → %s", (name, expected) => {
    expect(trustOf(name)).toBe(expected);
  });

  it("leaves mobile_ui untrusted on purpose — it returns device screen content", () => {
    expect(trustOf("mobile_ui")).toBe("untrusted");
    // Its sibling, which this plugin already judged the same way.
    expect(trustOf("computer")).toBe("untrusted");
  });

  it("keeps every name reachable through the CLI bridge and the MCP bridge", () => {
    expect(trustOf("mcp__openclaw__ls")).toBe("trusted");
    expect(trustOf("mcp__openclaw__agents_wait")).toBe("trusted");
    expect(trustOf("mcp__openclaw__skills_read")).toBe("external");
  });
});

describe("plugins / github_publish / transcripts resolve per action", () => {
  it("separates this gateway's plugin inventory from the remote catalog", () => {
    expect(resolveToolKey("plugins", { action: "list" }, COMPOSITES)).toBe("plugins.list");
    expect(trustOf("plugins", { action: "list" })).toBe("trusted");
    expect(trustOf("plugins", { action: "inspect" })).toBe("trusted");
    expect(trustOf("plugins", { action: "reloadAndResume" })).toBe("trusted");
    expect(trustOf("plugins", { action: "search" })).toBe("external");
    expect(trustOf("plugins", { action: "install" })).toBe("external");
    // An action we did not enumerate falls back to the bare tool's label.
    expect(trustOf("plugins", { action: "some-future-action" })).toBe("trusted");
  });

  it("separates our publication receipts from observed GitHub state", () => {
    expect(trustOf("github_publish", { action: "publish" })).toBe("trusted");
    expect(trustOf("github_publish", { action: "upload_evidence" })).toBe("trusted");
    expect(trustOf("github_publish", { action: "inspect_pr" })).toBe("external");
    expect(trustOf("github_publish", { action: "edit" })).toBe("external");
    expect(trustOf("github_publish", { action: "merge" })).toBe("external");
    // Action omitted = publish (the tool's documented default).
    expect(trustOf("github_publish")).toBe("trusted");
  });

  it("separates capture control from recorded speech", () => {
    expect(trustOf("transcripts", { action: "start" })).toBe("trusted");
    expect(trustOf("transcripts", { action: "stop" })).toBe("trusted");
    expect(trustOf("transcripts", { action: "status" })).toBe("trusted");
    expect(trustOf("transcripts", { action: "list" })).toBe("trusted");
    expect(trustOf("transcripts", { action: "show" })).toBe("external");
    expect(trustOf("transcripts", { action: "summarize" })).toBe("external");
    expect(trustOf("transcripts", { action: "import" })).toBe("external");
  });

  it("still resolves these composites when the bridge namespaces them", () => {
    expect(resolveToolKey("mcp__openclaw__plugins", { action: "search" }, COMPOSITES)).toBe(
      "plugins.search",
    );
    expect(trustOf("mcp__openclaw__plugins", { action: "search" })).toBe("external");
  });
});

describe("a bare MCP namespace is not an unknown tool", () => {
  it("labels mcp__openclaw by its namespace default", () => {
    // The literal name seen at 14:28:52: a truncated mcp__openclaw__exec that
    // Claude Code rejected with "No such tool available".
    expect(trustOf("mcp__openclaw")).toBe("trusted");
    expect(trustOf("mcp__openclaw__")).toBe("trusted");
    expect(trustOf("mcp__codex_apps")).toBe("trusted");
  });

  it("still refuses to guess for a namespace it does not know", () => {
    // Seen at 15:39:11 the same day. We know nothing about this server.
    expect(trustOf("mcp__observe")).toBe("untrusted");
    expect(trustOf("mcp__claude_ai")).toBe("untrusted");
  });
});

// ── Part 2: the lockouts, replayed ───────────────────────────────────────

describe("2026-11-12 lockouts, through the real hook pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-0ii-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const SESSION_KEY = "agent:main:isolated:planner";
  const CTX = { sessionKey: SESSION_KEY, agentId: "main", senderId: "owner-123" };
  const CONFIG: SecurityPluginConfig = {
    trustedSenderIds: ["owner-123"],
    taintPolicy: {
      trusted: "allow",
      shared: "restrict",
      external: "restrict",
      untrusted: "restrict",
    },
  };

  function startTurn() {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const { store } = registerSecurityHooks(api as any, logger as any, {
      ...CONFIG,
      workspaceDir: tmpDir,
    });
    api.fire(
      "context_assembled",
      {
        systemPrompt: "plan the release",
        messageCount: 1,
        messages: [{ role: "user", content: "plan the release" }],
      },
      CTX,
    );
    // The precondition every one of these incidents started from.
    expect(store.getActive(SESSION_KEY)!.maxTaint).toBe("trusted");
    return { api, logger, store };
  }

  /** The result agents_wait returns for children that finished. */
  function waitResult(sessionKeys: string[]) {
    const payload = {
      completed: sessionKeys.map((sessionKey, i) => ({
        runId: `run-${i + 1}`,
        status: "done",
        result: "wrote its section",
        sessionKey,
      })),
      pending: [],
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
  }

  it("agents_wait on its own local children no longer locks the parent out (11:10:45)", () => {
    const { api, logger, store } = startTurn();
    const children = [
      "agent:main:subagent:child-1",
      "agent:main:subagent:child-2",
      "agent:main:subagent:child-3",
      "agent:main:subagent:child-4",
    ];

    api.fire(
      "after_tool_call",
      { toolName: "agents_wait", params: { ids: ["run-1", "run-2", "run-3", "run-4"] }, result: waitResult(children) },
      CTX,
    );

    expect(store.getActive(SESSION_KEY)!.maxTaint).toBe("trusted");
    expect(logger.logs.find((l) => l.includes("TOOL_TAINT_ESCALATION"))).toBeUndefined();

    // The calls that were refused from 11:10:46 onward.
    for (const [toolName, params] of [
      ["exec", { command: "ls" }],
      ["write", { path: "plan.md" }],
      ["agents_wait", { ids: ["run-5"] }],
      ["sessions_spawn", { prompt: "go" }],
    ] as const) {
      expect(api.fire("before_tool_call", { toolName, params }, CTX)?.block).toBeFalsy();
    }
  });

  it("but a child that read the web still taints the parent that waits on it", () => {
    const { api, logger, store } = startTurn();
    const dirtyChild = "agent:main:subagent:child-web";
    // The child's own turn ended untrusted and sealed that watermark.
    getSharedWatermarkStore(tmpDir).escalate(
      dirtyChild,
      "untrusted",
      "tool output: web_fetch",
      "tool output: web_fetch",
    );

    api.fire(
      "after_tool_call",
      {
        toolName: "agents_wait",
        params: { ids: ["run-1", "run-2"] },
        result: waitResult(["agent:main:subagent:child-clean", dirtyChild]),
      },
      CTX,
    );

    expect(store.getActive(SESSION_KEY)!.maxTaint).toBe("untrusted");
    expect(logger.logs.find((l) => l.includes("TOOL_TAINT_ESCALATION"))).toContain("agents_wait");
    expect(api.fire("before_tool_call", { toolName: "exec", params: { command: "ls" } }, CTX)?.block).toBe(
      true,
    );
  });

  it("plugins no longer locks a session out (13:43:22, 13:45:26)", () => {
    const { api, store } = startTurn();
    api.fire(
      "after_tool_call",
      { toolName: "plugins", params: { action: "list" }, result: { content: [{ type: "text", text: "{}" }] } },
      CTX,
    );
    expect(store.getActive(SESSION_KEY)!.maxTaint).toBe("trusted");
    expect(api.fire("before_tool_call", { toolName: "exec", params: { command: "ls" } }, CTX)?.block).toBeFalsy();
  });

  it("a rejected mcp__openclaw call no longer locks a session out (14:28:52)", () => {
    const { api, logger, store } = startTurn();
    // Exactly what the harness relayed: a truncated name, no tool, an error.
    api.fire(
      "after_tool_call",
      {
        toolName: "mcp__openclaw",
        params: { command: "sed -n '110,135p' arm-run.sh" },
        result: {
          content: [
            { type: "text", text: "<tool_use_error>Error: No such tool available: mcp__openclaw</tool_use_error>" },
          ],
          isError: true,
        },
      },
      CTX,
    );
    expect(store.getActive(SESSION_KEY)!.maxTaint).toBe("trusted");
    expect(logger.logs.find((l) => l.includes("TOOL_TAINT_ESCALATION"))).toBeUndefined();
    // exec, tool_search and ls were all refused after this point in the journal.
    for (const toolName of ["exec", "tool_search", "ls"]) {
      expect(api.fire("before_tool_call", { toolName, params: {} }, CTX)?.block).toBeFalsy();
    }

    // Control: the secure default is still live in this very session. An
    // unrecognized namespace (mcp__observe, 15:39:11) escalates and blocks,
    // which is what makes the assertions above mean something.
    api.fire(
      "after_tool_call",
      { toolName: "mcp__observe", params: {}, result: { content: [{ type: "text", text: "?" }] } },
      CTX,
    );
    expect(store.getActive(SESSION_KEY)!.maxTaint).toBe("untrusted");
    expect(api.fire("before_tool_call", { toolName: "exec", params: {} }, CTX)?.block).toBe(true);
  });

  it("ls no longer re-taints a session (11:13:18, 14:29:03)", () => {
    const { api, store } = startTurn();
    api.fire(
      "after_tool_call",
      { toolName: "ls", params: { path: "~/reports" }, result: { content: [{ type: "text", text: '"BRIEF.md"' }] } },
      CTX,
    );
    expect(store.getActive(SESSION_KEY)!.maxTaint).toBe("trusted");
  });
});
