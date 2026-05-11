/**
 * Trust footer is emitted only on visible outbound reply surfaces.
 *
 * Regression for openclaw-provenance-rh3: after the hook-surface migration,
 * an inline-fallback in message_sending caused the developer-mode trust
 * footer to leak onto every interim outbound (mid-turn `message:send`
 * tool calls, streamed thinking-loop chunks). The footer should only
 * appear on the final assistant reply, where agent_end has staged its
 * final-taint snapshot.
 *
 * openclaw-provenance-2ak later made `message:send` tool calls an
 * intentional footer surface because group-chat final replies are delivered
 * through that tool path instead of the implicit final assistant reply.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSecurityHooks } from "../index.js";
import { makeApi } from "./test-shim.js";

function makeLogger() {
  const logs: string[] = [];
  return {
    info: (..._args: any[]) => logs.push(_args.join(" ")),
    warn: (..._args: any[]) => logs.push("WARN: " + _args.join(" ")),
    error: (..._args: any[]) => logs.push("ERROR: " + _args.join(" ")),
    logs,
  };
}

const FOOTER_RE = /trusted.*→.*trusted.*\| impacted:/;

describe("Developer-mode trust footer fires only on visible outbound replies", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "provenance-footer-final-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not append a footer to interim message_sending events (pre-agent_end)", () => {
    const api = makeApi(tmpDir);
    registerSecurityHooks(api, makeLogger(), {
      workspaceDir: tmpDir,
      verbose: false,
      developerMode: true,
    });

    const ctx = { sessionKey: "agent:tank:discord:tank:direct:1", workspaceDir: tmpDir };

    // Open the turn (drives turnStart bookkeeping inside provenance).
    api.fire(
      "before_prompt_build",
      { prompt: "tabitha is thinking…", messages: [{ role: "user", content: "go" }] },
      ctx,
    );

    // Two interim outbound deliveries — these are the streamed thinking-loop
    // chunks / mid-turn message:send tool sends. They precede agent_end.
    const interim1 = api.fire(
      "message_sending",
      { content: "Found a strong lead. Let me check the cron.", to: "user", metadata: { channel: "discord" } },
      ctx,
    );
    const interim2 = api.fire(
      "message_sending",
      { content: "Confirmed: spike happens at HH:MM:58 every minute.", to: "user", metadata: { channel: "discord" } },
      ctx,
    );

    expect(interim1?.content).toBeUndefined();
    expect(interim2?.content).toBeUndefined();
  });

  it("appends exactly one footer to the final outbound (post-agent_end)", () => {
    const api = makeApi(tmpDir);
    registerSecurityHooks(api, makeLogger(), {
      workspaceDir: tmpDir,
      verbose: false,
      developerMode: true,
    });

    const ctx = { sessionKey: "agent:tank:discord:tank:direct:2", workspaceDir: tmpDir };

    api.fire(
      "before_prompt_build",
      { prompt: "what's up?", messages: [{ role: "user", content: "what's up?" }] },
      ctx,
    );

    // Interim send — must be footer-free.
    const interim = api.fire(
      "message_sending",
      { content: "thinking out loud…", to: "user", metadata: { channel: "discord" } },
      ctx,
    );
    expect(interim?.content).toBeUndefined();

    // Turn closes — agent_end stages finalTaintBySession synchronously.
    const finalAssistantText = "Here's the answer.";
    api.fire(
      "agent_end",
      {
        messages: [{ role: "assistant", content: finalAssistantText }],
        success: true,
        durationMs: 0,
      },
      ctx,
    );

    // Final outbound — must carry exactly one footer.
    const final = api.fire(
      "message_sending",
      { content: finalAssistantText, to: "user", metadata: { channel: "discord" } },
      ctx,
    );
    expect(typeof final?.content).toBe("string");
    const footerMatches = (final!.content as string).match(/trusted.*→.*trusted.*\| impacted:/g) ?? [];
    expect(footerMatches.length).toBe(1);
    expect(final!.content as string).toContain(finalAssistantText);
    expect(FOOTER_RE.test(final!.content as string)).toBe(true);
  });

  it("does not append a footer to NO_REPLY or HEARTBEAT_OK final outputs", () => {
    const api = makeApi(tmpDir);
    registerSecurityHooks(api, makeLogger(), {
      workspaceDir: tmpDir,
      verbose: false,
      developerMode: true,
    });

    const ctx = { sessionKey: "agent:tank:discord:tank:direct:3", workspaceDir: tmpDir };

    api.fire(
      "before_prompt_build",
      { prompt: "ping", messages: [{ role: "user", content: "ping" }] },
      ctx,
    );

    // NO_REPLY agent_end is skipped by the silent-marker guard, so it
    // never stages finalTaintBySession; message_sending must therefore
    // emit no footer either.
    api.fire(
      "agent_end",
      { messages: [{ role: "assistant", content: "NO_REPLY" }], success: true, durationMs: 0 },
      ctx,
    );
    const noReply = api.fire(
      "message_sending",
      { content: "NO_REPLY", to: "user", metadata: { channel: "discord" } },
      ctx,
    );
    expect(noReply?.content).toBeUndefined();
  });

  it("clears stale staged final-taint at turn start (no carry-over to next turn's first interim send)", () => {
    const api = makeApi(tmpDir);
    registerSecurityHooks(api, makeLogger(), {
      workspaceDir: tmpDir,
      verbose: false,
      developerMode: true,
    });

    const ctx = { sessionKey: "agent:tank:discord:tank:direct:5", workspaceDir: tmpDir };

    // Turn N: a real reply turn. agent_end stages finalTaintBySession.
    // Simulate the previous turn's final message_sending NOT consuming
    // the staged entry (could happen if delivery fired with a different
    // sessionKey, was skipped for a non-text payload, etc.).
    api.fire(
      "before_prompt_build",
      { prompt: "prev turn", messages: [{ role: "user", content: "prev turn" }] },
      ctx,
    );
    api.fire(
      "agent_end",
      {
        messages: [{ role: "assistant", content: "prev reply" }],
        success: true,
        durationMs: 0,
      },
      ctx,
    );
    // No message_sending fires for that turn — staged entry remains.

    // Turn N+1 starts. before_prompt_build must clear the stale snapshot.
    api.fire(
      "before_prompt_build",
      { prompt: "new turn", messages: [{ role: "user", content: "new turn" }] },
      ctx,
    );

    // First interim outbound of the new turn must NOT carry a footer.
    const firstInterim = api.fire(
      "message_sending",
      { content: "Found a real suspect.", to: "user", metadata: { channel: "discord" } },
      ctx,
    );
    expect(firstInterim?.content).toBeUndefined();
  });

  it("appends a footer to before_tool_call message:send params", () => {
    const api = makeApi(tmpDir);
    registerSecurityHooks(api, makeLogger(), {
      workspaceDir: tmpDir,
      verbose: false,
      developerMode: true,
    });

    const ctx = { sessionKey: "agent:tank:discord:tank:direct:4", workspaceDir: tmpDir };

    api.fire(
      "before_prompt_build",
      { prompt: "hi", messages: [{ role: "user", content: "hi" }] },
      ctx,
    );

    // Agent emits a `message` tool call to send the visible group-chat reply.
    // Unlike streaming/interim message_sending chunks, this path is an
    // intentional developer-mode footer surface (openclaw-provenance-2ak).
    const result = api.fire(
      "before_tool_call",
      {
        toolName: "message",
        params: { action: "send", target: "user:1", message: "midway status" },
      },
      ctx,
    );
    expect(typeof result?.params?.message).toBe("string");
    expect(result.params.message).toContain("midway status");
    const footerMatches = (result.params.message as string).match(/trusted.*→.*trusted.*\| impacted:/g) ?? [];
    expect(footerMatches.length).toBe(1);
    expect(FOOTER_RE.test(result.params.message)).toBe(true);
  });
});
