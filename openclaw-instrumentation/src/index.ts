/**
 * OpenClaw Instrumentation plugin
 *
 * One turn id per conversational turn, born at message_received and threaded
 * through every lifecycle hook to message_sent. Emits ONE summary line per
 * finalized turn (console → journald) whose mark chain shows exactly where
 * the time went, plus a WARN for slow turns. Recent turns are inspectable at
 * GET /instrumentation (HTML) and /instrumentation/api/turns (JSON).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { TurnTracker, type TurnContext, type TurnRecord } from "./turn-tracker.js";

interface PluginApi {
  registerHttpRoute(params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }): void;
  pluginConfig?: Record<string, unknown>;
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  on?: (
    hookName: string,
    handler: (event: unknown, ctx: unknown) => unknown,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
}

interface InstrumentationConfig {
  summaryLine?: boolean;
  slowTurnWarnMs?: number;
  maxRetainedTurns?: number;
}

/** Hooks that only add a mark to whichever turn owns the session. */
const MARK_HOOKS = [
  "before_dispatch",
  "agent_turn_prepare",
  "before_model_resolve",
  "before_prompt_build",
  "before_agent_run",
  "llm_input",
  "llm_output",
  "before_tool_call",
  "after_tool_call",
  "before_agent_reply",
  "before_agent_finalize",
  "before_compaction",
  "after_compaction",
  "agent_end",
  "message_sending",
  "message_sent",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Hook payload shapes vary; scavenge correlation ids from both event and ctx. */
function extractTurnContext(event: unknown, ctx: unknown): TurnContext {
  const e = asRecord(event);
  const c = asRecord(ctx);
  return {
    agentId: str(c.agentId) ?? str(e.agentId),
    sessionKey: str(c.sessionKey) ?? str(e.sessionKey),
    sessionId: str(c.sessionId) ?? str(e.sessionId),
    channel: str(c.channel) ?? str(e.channel),
    messageId: str(e.messageId) ?? str(c.messageId),
  };
}

function extractDetail(hook: string, event: unknown): string | undefined {
  const e = asRecord(event);
  if (hook === "before_tool_call" || hook === "after_tool_call") {
    return str(e.toolName) ?? str(e.name);
  }
  if (hook === "message_received" || hook === "message_sent") {
    const channel = str(e.channel);
    return channel;
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
  return true;
}

function renderHtml(recent: TurnRecord[], open: TurnRecord[]): string {
  const row = (t: TurnRecord) => {
    const total = (t.endedAtMs ?? Date.now()) - t.startedAtMs;
    const chain = t.marks.map((m) => `${m.hook}+${m.atMs}`).join(" ");
    return (
      `<tr><td>${t.turnId}</td><td>${t.agentId ?? ""}</td><td>${total}ms</td>` +
      `<td>${t.llmIterations}</td><td>${t.toolCalls}</td>` +
      `<td class="chain">${chain}</td></tr>`
    );
  };
  return `<!doctype html><meta charset="utf-8"><title>OpenClaw Instrumentation</title>
<style>body{font:13px monospace;margin:1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:2px 6px;text-align:left}.chain{font-size:11px;max-width:60ch;overflow-wrap:anywhere}</style>
<h2>Open turns (${open.length})</h2>
<table><tr><th>turn</th><th>agent</th><th>elapsed</th><th>llm</th><th>tools</th><th>marks</th></tr>${open.map(row).join("")}</table>
<h2>Recent turns (${recent.length})</h2>
<table><tr><th>turn</th><th>agent</th><th>total</th><th>llm</th><th>tools</th><th>marks</th></tr>${recent.map(row).join("")}</table>`;
}

function activate(api: PluginApi): void {
  const config = (api.pluginConfig ?? {}) as InstrumentationConfig;
  const summaryLine = config.summaryLine !== false;
  const slowTurnWarnMs = config.slowTurnWarnMs ?? 10_000;
  const maxRetainedTurns = config.maxRetainedTurns ?? 200;

  const tracker = new TurnTracker({
    maxRetainedTurns,
    onFinalized: (summary) => {
      if (summary.totalMs >= slowTurnWarnMs) {
        api.logger.warn(`[instrumentation] SLOW ${summary.line}`);
        return;
      }
      if (summaryLine) {
        api.logger.info(`[instrumentation] ${summary.line}`);
      }
    },
  });

  if (typeof api.on !== "function") {
    api.logger.warn("[instrumentation] api.on unavailable; turn tracing disabled");
    return;
  }

  api.on("message_received", (event, ctx) => {
    const turnContext = extractTurnContext(event, ctx);
    tracker.beginTurn("message_received", turnContext);
    return undefined;
  });

  for (const hook of MARK_HOOKS) {
    api.on(hook, (event, ctx) => {
      tracker.mark(hook, extractTurnContext(event, ctx), extractDetail(hook, event));
      return undefined;
    });
  }

  api.registerHttpRoute({
    path: "/instrumentation/api/turns",
    auth: "gateway",
    match: "exact",
    handler: (_req, res) =>
      sendJson(res, 200, { open: tracker.openTurns(), recent: tracker.recentTurns() }),
  });
  api.registerHttpRoute({
    path: "/instrumentation",
    auth: "gateway",
    match: "exact",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(renderHtml(tracker.recentTurns(), tracker.openTurns()));
      return true;
    },
  });

  api.logger.info(
    `[instrumentation] turn tracing armed (${MARK_HOOKS.length + 1} hooks, summary=${summaryLine}, slowWarn=${slowTurnWarnMs}ms)`,
  );
}

// Upstream loader contract (July 2026): a `register` function is resolved from
// the default export; named `activate` alone fails validation. Alias it.
export default { id: "instrumentation", register: activate, activate };
