/**
 * Translates the Claude Agent SDK's `canUseTool` callback into the codex
 * server→client approval protocol. When Claude wants to invoke a tool, the
 * SDK calls us; we classify the tool, emit a JSON-RPC request to the plugin
 * (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
 * etc.), await the decision, and return allow/deny to the SDK.
 *
 * Bypass paths:
 *   - server-wide `OPENCLAW_CLAUDE_BRIDGE_ALLOW_ALL=1` env var
 *   - thread-level codex `approvalPolicy: "never"` set at thread/start
 *
 * Tools served by our own openclaw MCP server (prefixed `mcp__openclaw__`)
 * always allow at this layer because they're already gated by the
 * `item/tool/call` request the plugin receives during execution.
 */

import { randomUUID } from "node:crypto";

import type { Logger } from "./transport.js";

const APPROVAL_TIMEOUT_MS = 600_000;

const OPENCLAW_MCP_PREFIX = "mcp__openclaw__";
const COMMAND_EXECUTION_METHOD = "item/commandExecution/requestApproval";
const FILE_CHANGE_METHOD = "item/fileChange/requestApproval";

const FILE_EDIT_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "FileChange",
  "ApplyPatch",
]);

const COMMAND_EXECUTION_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "Shell",
  "Exec",
  "KillBash",
  "KillShell",
]);

export type ToolContext = {
  threadId: string;
  turnId: string;
};

export type RequestClient = (
  method: string,
  params: unknown,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<unknown>;

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal },
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;

export type ApprovalBridgeConfig = {
  ctx: ToolContext;
  requestClient: RequestClient;
  /**
   * When true, every tool call auto-allows without contacting the plugin.
   * Set when the user has opted into a global bypass OR the thread's
   * approval policy is `"never"`.
   */
  allowAll: boolean;
  logger: Logger;
};

export function buildCanUseTool(cfg: ApprovalBridgeConfig): CanUseTool {
  return async (toolName, input, options) => {
    if (cfg.allowAll) return { behavior: "allow" };
    if (toolName.startsWith(OPENCLAW_MCP_PREFIX)) return { behavior: "allow" };

    const callId = randomUUID();
    const method = classifyApprovalMethod(toolName);
    const params = buildApprovalParams(method, cfg.ctx, callId, toolName, input);

    try {
      const resp = await cfg.requestClient(method, params, {
        signal: options.signal,
        timeoutMs: APPROVAL_TIMEOUT_MS,
      });
      const decision = readDecision(resp);
      if (decision.allow) return { behavior: "allow" };
      return { behavior: "deny", message: decision.reason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cfg.logger.warn("[approval] request failed", { method, toolName, error: message });
      return { behavior: "deny", message };
    }
  };
}

export function classifyApprovalMethod(toolName: string): string {
  if (FILE_EDIT_TOOLS.has(toolName)) return FILE_CHANGE_METHOD;
  // Default everything else through commandExecution — most coarse, but
  // matches how codex routes "unknown destructive" calls. The plugin's
  // approval handler can still inspect the toolName field to refine.
  return COMMAND_EXECUTION_METHOD;
}

export function buildApprovalParams(
  method: string,
  ctx: ToolContext,
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (method === FILE_CHANGE_METHOD) {
    return {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      callId,
      changes: extractFileChanges(toolName, input),
      reason: `Claude is invoking ${toolName}`,
      toolName,
      toolInput: input,
    };
  }
  return {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    callId,
    command: extractCommand(toolName, input),
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    reason: `Claude is invoking ${toolName}`,
    toolName,
    toolInput: input,
  };
}

function extractCommand(toolName: string, input: Record<string, unknown>): string[] {
  if (COMMAND_EXECUTION_TOOLS.has(toolName)) {
    const cmd = typeof input.command === "string" ? input.command : undefined;
    if (cmd) return ["sh", "-c", cmd];
    if (toolName === "BashOutput" || toolName === "KillBash" || toolName === "KillShell") {
      const id = typeof input.bash_id === "string" ? input.bash_id : "";
      return [toolName, id];
    }
  }
  // Non-command tools still need a `command` field per codex's schema; pass
  // a placeholder with the tool name so the plugin's approval handler has
  // something useful to display.
  const summary = Object.entries(input)
    .map(([k, v]) => `${k}=${truncate(JSON.stringify(v))}`)
    .join(" ");
  return [toolName, summary];
}

function extractFileChanges(
  toolName: string,
  input: Record<string, unknown>,
): Array<{ path: string; kind: string }> {
  const file = typeof input.file_path === "string" ? input.file_path : undefined;
  if (file) {
    const kind = toolName === "Write" ? "create" : "modify";
    return [{ path: file, kind }];
  }
  if (Array.isArray(input.edits)) {
    // MultiEdit / batch shape — collect paths.
    const paths = new Set<string>();
    for (const edit of input.edits) {
      if (edit && typeof edit === "object" && typeof (edit as { file_path?: unknown }).file_path === "string") {
        paths.add((edit as { file_path: string }).file_path);
      }
    }
    return [...paths].map((p) => ({ path: p, kind: "modify" }));
  }
  return [];
}

export function readDecision(raw: unknown): { allow: boolean; reason: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const decision = obj.decision;
    if (decision === "approve" || decision === "approve_for_session") {
      return { allow: true, reason: "" };
    }
    if (decision === "decline") {
      const reason = typeof obj.reason === "string" ? obj.reason : "client declined";
      return { allow: false, reason };
    }
    // No decision field? Treat absent decision as decline for safety.
    const reason = typeof obj.reason === "string" ? obj.reason : "client returned no decision";
    return { allow: false, reason };
  }
  return { allow: false, reason: "client returned malformed approval response" };
}

function truncate(s: string, n = 80): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
