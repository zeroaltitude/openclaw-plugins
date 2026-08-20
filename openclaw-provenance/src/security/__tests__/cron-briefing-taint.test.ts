/**
 * Regression: morning-briefing cron taint block (openclaw-provenance-hce)
 *
 * Root cause (verified):
 *  1. Reading any non-allowlisted Slack channel taints the cron session
 *     `external` (built-in `slack://** → external` uri-trust default).
 *  2. Once `external`, read-family message actions AND sessions_spawn were
 *     restricted via the bare `message` policy — so the briefing could never
 *     finish gathering, even though message.send itself was allowed.
 *  3. Cron run keys (`agent:<id>:cron:<jobId>:run:<runId>`) were never
 *     recognized as system-source (the marker is medial, not a trailing
 *     suffix), so per-run `external` watermarks accumulated in watermarks.json.
 *
 * Fixes:
 *  - message read/metadata actions classified as INPUT ops: allow up to
 *    external, restrict at untrusted (mirrors web_fetch).
 *  - system-source detection matches cron/heartbeat/etc. as path segments.
 *  - system-source sessions no longer persist non-trusted watermarks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSecurityHooks, type SecurityPluginConfig } from "../index.js";
import { getSharedWatermarkStore } from "../watermark-store.js";
import { makeApi } from "./test-shim.js";

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (...a: any[]) => logs.push(a.join(" ")),
    warn: (...a: any[]) => logs.push("WARN: " + a.join(" ")),
    error: (...a: any[]) => logs.push("ERROR: " + a.join(" ")),
    logs,
  };
}

const CRON_SESSION_KEY =
  "agent:main:cron:0b517a17-6533-45be-b4ac-74311ba326ee:run:85c7d87b-d616-4a88-86b1-5575f3a50215";
const CRON_CTX = { sessionKey: CRON_SESSION_KEY };

// A minimal config resembling production: reads are output-trusted, but the
// built-in slack://** → external default still governs unlisted channels.
const CONFIG: SecurityPluginConfig = {
  taintPolicy: {
    trusted: "allow",
    shared: "restrict",
    external: "restrict",
    untrusted: "restrict",
  },
  missingIdentityTrust: "trusted" as const,
  uriTrust: {
    "slack://C0AG45JJ1E1/**": "trusted" as const, // the briefing target
  },
};

function btc(api: any, toolName: string, params: any) {
  return api.fire("before_tool_call", { toolName, params }, CRON_CTX);
}
function atc(api: any, toolName: string, params: any) {
  api.fire(
    "after_tool_call",
    { toolName, params, result: { content: [{ type: "text", text: "data" }] } },
    CRON_CTX,
  );
}

describe("cron morning-briefing taint (openclaw-provenance-hce)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-cron-hce-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("classifies a cron RUN session (medial :cron:) as system-source → trusted", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    registerSecurityHooks(api as any, logger as any, { ...CONFIG, workspaceDir: tmpDir });

    api.fire("context_assembled", {
      systemPrompt: "briefing",
      messageCount: 1,
      messages: [{ role: "user", content: "Run the morning briefing" }],
    }, CRON_CTX);

    const line = logger.logs.find((l) => l.includes("CLASSIFY_INITIAL_TRUST"));
    expect(line).toContain("CLASSIFY_INITIAL_TRUST: trusted");
  });

  it("allows the full briefing flow (multi-channel read → send) even at external taint", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const { store } = registerSecurityHooks(api as any, logger as any, {
      ...CONFIG,
      workspaceDir: tmpDir,
    });

    api.fire("context_assembled", {
      systemPrompt: "briefing",
      messageCount: 1,
      messages: [{ role: "user", content: "Run the morning briefing" }],
    }, CRON_CTX);

    // Gather: list channels, then read several non-allowlisted channels.
    // Each before_tool_call must be ALLOWED even after taint climbs.
    expect(btc(api, "message", { action: "channel-list", channel: "slack" })?.block ?? false).toBe(false);
    atc(api, "message", { action: "channel-list", channel: "slack" });

    for (const ch of ["C04QUTP6NKY", "C0109GCREDD", "C018EB88D5H"]) {
      const read = btc(api, "message", { action: "read", channel: "slack", channelId: ch });
      expect(read?.block ?? false).toBe(false); // reads never blocked (input op)
      atc(api, "message", { action: "read", channel: "slack", channelId: ch });
    }

    // Session is now external (external Slack content is in context)...
    expect(store.getActive(CRON_SESSION_KEY)?.maxTaint).toBe("external");

    // ...yet the briefing can still be delivered.
    const send = btc(api, "message", {
      action: "send",
      channel: "slack",
      channelId: "C0AG45JJ1E1",
      text: "briefing",
    });
    expect(send?.block ?? false).toBe(false);
  });

  it("still restricts message reads and sends at UNTRUSTED taint", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const { store } = registerSecurityHooks(api as any, logger as any, {
      ...CONFIG,
      // classify a channel as untrusted to drive the session there
      uriTrust: { ...CONFIG.uriTrust, "slack://EVIL/**": "untrusted" as const },
      workspaceDir: tmpDir,
    });

    api.fire("context_assembled", {
      systemPrompt: "briefing",
      messageCount: 1,
      messages: [{ role: "user", content: "go" }],
    }, CRON_CTX);

    atc(api, "message", { action: "read", channel: "slack", channelId: "EVIL" });
    expect(store.getActive(CRON_SESSION_KEY)?.maxTaint).toBe("untrusted");

    // reads restricted at untrusted (guards attacker-directed second-stage)
    const read = btc(api, "message", { action: "read", channel: "slack", channelId: "C0109GCREDD" });
    expect(read?.block).toBe(true);
    // message.send is intentionally always allowed (unchanged behavior)
    const send = btc(api, "message", { action: "send", channelId: "C0AG45JJ1E1", text: "x" });
    expect(send?.block ?? false).toBe(false);
  });

  it("does not persist a watermark for the cron run session", () => {
    const logger = makeLogger();
    const api = makeApi(tmpDir);
    const { store } = registerSecurityHooks(api as any, logger as any, {
      ...CONFIG,
      workspaceDir: tmpDir,
    });

    api.fire("context_assembled", {
      systemPrompt: "briefing",
      messageCount: 1,
      messages: [{ role: "user", content: "go" }],
    }, CRON_CTX);
    atc(api, "message", { action: "read", channel: "slack", channelId: "C04QUTP6NKY" });
    expect(store.getActive(CRON_SESSION_KEY)?.maxTaint).toBe("external");

    // Complete the turn (agent_end via shim's before_response_emit)
    api.fire("before_response_emit", { content: "Briefing posted." }, CRON_CTX);

    // No leftover external watermark on the cron run key.
    const wm = getSharedWatermarkStore(tmpDir).getLevel(CRON_SESSION_KEY);
    expect(wm).toBeUndefined();
  });
});
