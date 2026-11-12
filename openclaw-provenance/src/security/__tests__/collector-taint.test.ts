/**
 * Collector-wait taint — unit tests (openclaw-provenance-0ii).
 *
 * agents_wait carries the maximum taint of the children it collected. These
 * tests pin the three parts of that: recognising the tool under every name a
 * harness reports it by, reading the child session keys out of every result
 * shape the tool can arrive in, and folding the children's levels.
 */

import { describe, it, expect } from "vitest";
import {
  extractCollectedSessionKeys,
  isCollectorWaitTool,
  resolveCollectorChildTaint,
} from "../collector-taint.js";
import type { TrustLevel } from "../trust-levels.js";

/** The payload shape agents_wait returns (openclaw CollectorCompletionSchema). */
function waitPayload(children: Array<{ runId: string; sessionKey: string }>) {
  return {
    completed: children.map((child) => ({
      runId: child.runId,
      status: "done",
      result: "done",
      sessionKey: child.sessionKey,
    })),
    pending: [],
  };
}

/** jsonResult() = textResult(JSON.stringify(payload), payload). */
function asToolResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

describe("isCollectorWaitTool", () => {
  it("recognises the bare, MCP-namespaced and bridge-flattened names", () => {
    expect(isCollectorWaitTool("agents_wait")).toBe(true);
    expect(isCollectorWaitTool("mcp__openclaw__agents_wait")).toBe(true);
    expect(isCollectorWaitTool("openclawagents_wait")).toBe(true);
  });

  it("does not claim neighbouring tools", () => {
    expect(isCollectorWaitTool("agents_list")).toBe(false);
    expect(isCollectorWaitTool("wait_agent")).toBe(false);
    expect(isCollectorWaitTool("wait")).toBe(false);
    expect(isCollectorWaitTool("sessions_spawn")).toBe(false);
  });
});

describe("extractCollectedSessionKeys", () => {
  const payload = waitPayload([
    { runId: "run-1", sessionKey: "agent:main:subagent:child-1" },
    { runId: "run-2", sessionKey: "agent:main:subagent:child-2" },
  ]);

  it("reads the details payload", () => {
    expect(extractCollectedSessionKeys(asToolResult(payload))).toEqual([
      "agent:main:subagent:child-1",
      "agent:main:subagent:child-2",
    ]);
  });

  it("reads the serialized content[].text when details is absent", () => {
    const serializedOnly = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    expect(extractCollectedSessionKeys(serializedOnly)).toEqual([
      "agent:main:subagent:child-1",
      "agent:main:subagent:child-2",
    ]);
  });

  it("reads a raw payload object", () => {
    expect(extractCollectedSessionKeys(payload)).toEqual([
      "agent:main:subagent:child-1",
      "agent:main:subagent:child-2",
    ]);
  });

  it("returns nothing for results that collected no child", () => {
    expect(extractCollectedSessionKeys(asToolResult({ completed: [], pending: ["run-1"] }))).toEqual(
      [],
    );
    expect(extractCollectedSessionKeys(undefined)).toEqual([]);
    expect(extractCollectedSessionKeys("not an object")).toEqual([]);
    expect(
      extractCollectedSessionKeys({ content: [{ type: "text", text: "{not json" }] }),
    ).toEqual([]);
  });

  it("ignores an errors-only result (not_found / not_owner relay no output)", () => {
    const errored = asToolResult({
      completed: [],
      pending: [],
      errors: [{ runId: "run-9", error: "not_found" }],
    });
    expect(extractCollectedSessionKeys(errored)).toEqual([]);
  });
});

describe("resolveCollectorChildTaint", () => {
  const twoChildren = asToolResult(
    waitPayload([
      { runId: "run-1", sessionKey: "child-1" },
      { runId: "run-2", sessionKey: "child-2" },
    ]),
  );

  it("is trusted when every child stayed trusted", () => {
    const resolved = resolveCollectorChildTaint(twoChildren, () => "trusted");
    expect(resolved.trust).toBe("trusted");
    expect(resolved.sessionKeys).toEqual(["child-1", "child-2"]);
  });

  it("takes the MAXIMUM taint, not the first or the last", () => {
    const levels: Record<string, TrustLevel> = { "child-1": "trusted", "child-2": "untrusted" };
    expect(resolveCollectorChildTaint(twoChildren, (key) => levels[key]).trust).toBe("untrusted");

    const reversed: Record<string, TrustLevel> = { "child-1": "external", "child-2": "trusted" };
    expect(resolveCollectorChildTaint(twoChildren, (key) => reversed[key]).trust).toBe("external");
  });

  it("treats an unknown child as trusted — no watermark means it never escalated", () => {
    const resolved = resolveCollectorChildTaint(twoChildren, () => undefined);
    expect(resolved.trust).toBe("trusted");
    expect(resolved.levels).toEqual(["trusted", "trusted"]);
  });

  it("is trusted when nothing was collected at all", () => {
    const pendingOnly = asToolResult({ completed: [], pending: ["run-1"] });
    const resolved = resolveCollectorChildTaint(pendingOnly, () => "untrusted");
    expect(resolved.trust).toBe("trusted");
    expect(resolved.sessionKeys).toEqual([]);
  });
});
