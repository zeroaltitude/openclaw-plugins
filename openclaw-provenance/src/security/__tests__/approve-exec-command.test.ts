import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSecurityHooks, type SecurityPluginConfig } from "../index.js";
import { makeApi } from "./test-shim.js";

const SESSION_KEY = "agent:main:direct:owner";
const CONTEXT = { sessionKey: SESSION_KEY };
const CONFIG: SecurityPluginConfig = {
  taintPolicy: { trusted: "restrict" },
  toolOverrides: { browser: { trusted: "restrict" } },
};

function startTurn(api: ReturnType<typeof makeApi>) {
  api.fire(
    "context_assembled",
    { systemPrompt: "test", messageCount: 1, messages: [{ role: "user", content: "test" }] },
    CONTEXT,
  );
}

function endTurn(api: ReturnType<typeof makeApi>) {
  api.fire("before_response_emit", { content: "done" }, CONTEXT);
}

describe("/approve-exec", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "provenance-approval-command-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("keeps default session approval across turns and applies it to composite actions", () => {
    const api = makeApi(workspaceDir);
    registerSecurityHooks(api as any, console as any, { ...CONFIG, workspaceDir });

    startTurn(api);
    expect(api.fire("before_tool_call", { toolName: "browser", params: { action: "snapshot" } }, CONTEXT)).toMatchObject({ block: true });

    expect(api.invokeCommand("approve-exec", { args: "browser", sessionKey: SESSION_KEY }).text).toContain("this session");
    expect(api.fire("before_tool_call", { toolName: "browser", params: { action: "snapshot" } }, CONTEXT)).toBeUndefined();
    endTurn(api);

    startTurn(api);
    expect(api.fire("before_tool_call", { toolName: "browser", params: { action: "snapshot" } }, CONTEXT)).toBeUndefined();
  });

  it("clears explicit turn approval at the end of the turn", () => {
    const api = makeApi(workspaceDir);
    registerSecurityHooks(api as any, console as any, { ...CONFIG, workspaceDir });

    startTurn(api);
    expect(api.invokeCommand("approve-exec", { args: "browser turn", sessionKey: SESSION_KEY }).text).toContain("this turn");
    expect(api.fire("before_tool_call", { toolName: "browser", params: { action: "snapshot" } }, CONTEXT)).toBeUndefined();
    endTurn(api);

    startTurn(api);
    expect(api.fire("before_tool_call", { toolName: "browser", params: { action: "snapshot" } }, CONTEXT)).toMatchObject({ block: true });
  });
});
