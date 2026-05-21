import { describe, expect, it } from "vitest";

import {
  buildApprovalParams,
  buildCanUseTool,
  classifyApprovalMethod,
  readDecision,
} from "../src/approval-bridge.js";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("classifyApprovalMethod", () => {
  it("routes file-edit tools to fileChange", () => {
    expect(classifyApprovalMethod("Write")).toBe("item/fileChange/requestApproval");
    expect(classifyApprovalMethod("Edit")).toBe("item/fileChange/requestApproval");
    expect(classifyApprovalMethod("MultiEdit")).toBe("item/fileChange/requestApproval");
    expect(classifyApprovalMethod("NotebookEdit")).toBe("item/fileChange/requestApproval");
    expect(classifyApprovalMethod("ApplyPatch")).toBe("item/fileChange/requestApproval");
  });

  it("routes shell/bash/other tools to commandExecution", () => {
    expect(classifyApprovalMethod("Bash")).toBe("item/commandExecution/requestApproval");
    expect(classifyApprovalMethod("Shell")).toBe("item/commandExecution/requestApproval");
    expect(classifyApprovalMethod("Read")).toBe("item/commandExecution/requestApproval");
    expect(classifyApprovalMethod("Glob")).toBe("item/commandExecution/requestApproval");
  });
});

describe("buildApprovalParams", () => {
  const ctx = { threadId: "t-1", turnId: "u-1" };

  it("commandExecution shape carries command array + toolName + toolInput", () => {
    const p = buildApprovalParams(
      "item/commandExecution/requestApproval",
      ctx,
      "call-1",
      "Bash",
      { command: "echo hi", description: "say hi" },
    );
    expect(p.threadId).toBe("t-1");
    expect(p.turnId).toBe("u-1");
    expect(p.callId).toBe("call-1");
    expect(p.command).toEqual(["sh", "-c", "echo hi"]);
    expect(p.toolName).toBe("Bash");
    expect(p.toolInput).toEqual({ command: "echo hi", description: "say hi" });
  });

  it("fileChange shape carries changes from file_path", () => {
    const p = buildApprovalParams(
      "item/fileChange/requestApproval",
      ctx,
      "call-2",
      "Write",
      { file_path: "/tmp/x.txt", content: "hi" },
    );
    expect(p.changes).toEqual([{ path: "/tmp/x.txt", kind: "create" }]);
    expect(p.toolName).toBe("Write");
  });

  it("fileChange handles MultiEdit-style batched edits", () => {
    const p = buildApprovalParams(
      "item/fileChange/requestApproval",
      ctx,
      "call-3",
      "MultiEdit",
      { edits: [{ file_path: "/tmp/a.txt", old_string: "x" }, { file_path: "/tmp/b.txt", old_string: "y" }] },
    );
    const changes = p.changes as Array<{ path: string; kind: string }>;
    expect(changes).toHaveLength(2);
    const paths = new Set(changes.map((c) => c.path));
    expect(paths.has("/tmp/a.txt")).toBe(true);
    expect(paths.has("/tmp/b.txt")).toBe(true);
  });
});

describe("readDecision", () => {
  it("treats approve/approve_for_session as allow", () => {
    expect(readDecision({ decision: "approve" })).toEqual({ allow: true, reason: "" });
    expect(readDecision({ decision: "approve_for_session" })).toEqual({ allow: true, reason: "" });
  });

  it("treats decline as deny with reason", () => {
    expect(readDecision({ decision: "decline", reason: "nope" })).toEqual({
      allow: false,
      reason: "nope",
    });
  });

  it("defaults missing decision to deny", () => {
    expect(readDecision({}).allow).toBe(false);
  });

  it("treats malformed input as deny", () => {
    expect(readDecision(null).allow).toBe(false);
    expect(readDecision("oops").allow).toBe(false);
    expect(readDecision(42).allow).toBe(false);
  });
});

describe("buildCanUseTool", () => {
  it("auto-allows when allowAll is set", async () => {
    const fn = buildCanUseTool({
      ctx: { threadId: "t", turnId: "u" },
      requestClient: async () => ({ decision: "decline" }),
      allowAll: true,
      logger: noopLogger,
    });
    const result = await fn("Bash", { command: "rm -rf /" }, { signal: new AbortController().signal });
    expect(result).toEqual({ behavior: "allow" });
  });

  it("auto-allows openclaw-prefixed dynamic tools without contacting the plugin", async () => {
    let called = false;
    const fn = buildCanUseTool({
      ctx: { threadId: "t", turnId: "u" },
      requestClient: async () => {
        called = true;
        return { decision: "decline" };
      },
      allowAll: false,
      logger: noopLogger,
    });
    const result = await fn("mcp__openclaw__some_tool", {}, {});
    expect(result).toEqual({ behavior: "allow" });
    expect(called).toBe(false);
  });

  it("forwards non-openclaw tool calls to the plugin via requestClient", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const fn = buildCanUseTool({
      ctx: { threadId: "t-9", turnId: "u-9" },
      requestClient: async (method, params) => {
        calls.push({ method, params });
        return { decision: "approve" };
      },
      allowAll: false,
      logger: noopLogger,
    });
    const result = await fn("Bash", { command: "ls" }, {});
    expect(result).toEqual({ behavior: "allow" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("item/commandExecution/requestApproval");
    expect((calls[0]!.params as { threadId: string }).threadId).toBe("t-9");
    expect((calls[0]!.params as { turnId: string }).turnId).toBe("u-9");
  });

  it("returns deny when requestClient rejects", async () => {
    const fn = buildCanUseTool({
      ctx: { threadId: "t", turnId: "u" },
      requestClient: async () => { throw new Error("client offline"); },
      allowAll: false,
      logger: noopLogger,
    });
    const result = await fn("Bash", { command: "ls" }, {});
    expect(result).toEqual({ behavior: "deny", message: "client offline" });
  });

  it("returns deny when the plugin declines", async () => {
    const fn = buildCanUseTool({
      ctx: { threadId: "t", turnId: "u" },
      requestClient: async () => ({ decision: "decline", reason: "no" }),
      allowAll: false,
      logger: noopLogger,
    });
    const result = await fn("Bash", { command: "ls" }, {});
    expect(result).toEqual({ behavior: "deny", message: "no" });
  });
});
